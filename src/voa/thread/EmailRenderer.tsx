import { useRef, useCallback, useMemo, useState, useEffect } from "react";
import { ImageOff } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useDark } from "@/voa/settings/appearance";
import { appImage, hasBlockedImages, stripRemoteImages, throughApp } from "@/utils/imageBlocker";
import { addToAllowlist } from "@/services/db/imageAllowlist";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import type { DbAttachment } from "@/services/db/attachments";
import { isolateLinks } from "./openEmailLinks";
import { noContextMenu } from "../ui/contextMenu";

/** A voa token's value (they are light-dark() pairs), so the iframe can follow the same palette. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
  return v || fallback;
}

/**
 * No allow-scripts, allow-top-navigation or allow-forms. allow-popups is how an
 * http(s)/mailto link leaves (the shell opens it outside, see isolateLinks).
 */
export const MAIL_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * The frame's color scheme, set on the iframe and on its document alike: when the two
 * differ, WebKit paints an opaque canvas behind the mail.
 */
function scheme(isDark: boolean, isPlainText: boolean): "light" | "dark" {
  return isDark && isPlainText ? "dark" : "light";
}

interface EmailRendererProps {
  html: string | null;
  text: string | null;
  blockImages?: boolean;
  senderAddress?: string | null;
  accountId?: string | null;
  senderAllowlisted?: boolean;
  messageId?: string | null;
  inlineAttachments?: DbAttachment[];
  /** The frame has its content's height, once per mail document (what is on screen can now be placed). */
  onSized?: () => void;
}

export function EmailRenderer({
  html,
  text,
  blockImages = false,
  senderAddress,
  accountId,
  senderAllowlisted = false,
  messageId,
  inlineAttachments,
  onSized,
}: EmailRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [overrideShow, setOverrideShow] = useState(false);
  const [cidMap, setCidMap] = useState<Map<string, string>>(new Map());

  const isDark = useDark();

  const shouldBlock = blockImages && !senderAllowlisted && !overrideShow;

  // Resolve cid: references by fetching inline attachment data
  useEffect(() => {
    if (!accountId || !messageId || !inlineAttachments?.length) return;

    const cidAttachments = inlineAttachments.filter(
      (a) => a.content_id && a.gmail_attachment_id,
    );
    if (cidAttachments.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const { getEmailProvider } = await import("@/services/email/providerFactory");
        const provider = await getEmailProvider(accountId);
        const resolved = new Map<string, string>();

        await Promise.all(
          cidAttachments.map(async (att) => {
            try {
              const response = await provider.fetchAttachment(
                messageId,
                att.gmail_attachment_id!,
              );
              const base64 = response.data.replace(/-/g, "+").replace(/_/g, "/");
              resolved.set(att.content_id!, `data:${att.mime_type ?? "image/png"};base64,${base64}`);
            } catch {
              // Skip individual failures
            }
          }),
        );

        if (!cancelled && resolved.size > 0) {
          setCidMap(resolved);
        }
      } catch {
        // Non-critical: images just won't render
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, messageId, inlineAttachments]);

  // Sanitize once: reused by both content and blocked-image check
  const sanitizedBody = useMemo(() => {
    if (!html) return null;
    return sanitizeHtml(html);
  }, [html]);

  const isPlainText = !sanitizedBody;

  const bodyHtml = useMemo(() => {
    let body = sanitizedBody
      ?? `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text ?? "")}</pre>`;

    if (shouldBlock && sanitizedBody) {
      body = stripRemoteImages(body);
    }

    // Replace cid: references with resolved data URIs
    if (cidMap.size > 0) {
      body = body.replace(
        /\bcid:([^"'\s)]+)/gi,
        (match, cidRef: string) => cidMap.get(cidRef) ?? match,
      );
    }

    // In the app, remote images come through it (voa-img): a sender's rules for browsers do not hide them.
    if (sanitizedBody && "__TAURI_INTERNALS__" in window) body = throughApp(body, (url) => appImage(convertFileSrc, url));

    return body;
  }, [sanitizedBody, text, shouldBlock, cidMap]);

  const blocked = useMemo(() => {
    if (!shouldBlock || !sanitizedBody) return false;
    return hasBlockedImages(stripRemoteImages(sanitizedBody));
  }, [shouldBlock, sanitizedBody]);

  // Mail renders in its own document: a sandboxed iframe with no scripts, no
  // top navigation and no forms, so nothing in it can cover or drive the app.
  // allow-same-origin only lets this page measure its height; with no scripts
  // the mail itself can do nothing with it.
  const srcDoc = useMemo(() => {
    const htmlDark = isDark && !isPlainText;
    // Plain text uses the app's own ink on its canvas. HTML emails keep a light page: senders design for white.
    const ink = token("ink", "#1d1d1f");
    const ink2 = token("ink-2", "#6e6e73");
    const line = token("line", "rgba(0, 0, 0, 0.07)");
    const accent = token("accent", "#1d1d1f");
    return `<!DOCTYPE html><html><head><style>
      :root { color-scheme: ${scheme(isDark, isPlainText)}; display: flow-root; }
      body {
        margin: 0;
        padding: 0 0 8px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: ${htmlDark ? "#1f2937" : ink};
        background: ${htmlDark ? "#f8f9fa" : "transparent"};
        word-wrap: break-word;
        overflow-wrap: break-word;
        overflow: hidden;
      }
      img { max-width: 100%; height: auto; }
      a[href] { color: ${htmlDark ? "#1d1d1f" : accent}; text-decoration: underline; cursor: pointer; }
      blockquote {
        border-left: 2px solid ${htmlDark ? "#d1d5db" : line};
        margin: 8px 0;
        padding: 2px 12px;
        color: ${htmlDark ? "#6b7280" : ink2};
      }
      /* Like Gmail: the sender's line breaks and spacing stay, a line longer than the reader wraps instead of scrolling. */
      pre { white-space: pre-wrap; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
      table { max-width: 100%; }
    </style></head><body>${isolateLinks(bodyHtml)}</body></html>`;
  }, [bodyHtml, isDark, isPlainText]);

  // The frame is as tall as its content: as soon as the mail's document is parsed (not at load, which waits for every
  // image: a tracking pixel that redirects for 30 s kept the frame at its default 150 px), and whenever its content
  // resizes (an image arriving, the window getting narrower). The root's box, not its scrollHeight, which never drops
  // below the frame's current height.
  const observerRef = useRef<ResizeObserver | null>(null);
  const onSizedRef = useRef(onSized);
  useEffect(() => {
    onSizedRef.current = onSized;
  });
  const setUpRef = useRef<Document | null>(null);
  const setUp = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc?.body) return false;
    const root = doc.documentElement;
    const body = doc.body;
    const fit = () => {
      const h = Math.ceil(Math.max(root.getBoundingClientRect().height, body.scrollHeight));
      if (h > 0) iframe.style.height = `${h}px`;
    };
    fit();
    if (setUpRef.current === doc) return true;
    setUpRef.current = doc;
    observerRef.current?.disconnect();
    observerRef.current = new ResizeObserver(fit);
    observerRef.current.observe(root);
    observerRef.current.observe(body);
    noContextMenu(doc);
    // A click in the mail moves focus into the frame, where the app's keys (window keydown) do not arrive.
    // The first plain key hands focus back and reaches the app, so E right after a click acts at once.
    // A key with a modifier (Cmd+C on a selection) stays in the mail, but Cmd+Z, which undoes in the app: the mail has
    // nothing to undo.
    doc.addEventListener("keydown", (e) => {
      const undo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z";
      if ((e.metaKey || e.ctrlKey || e.altKey) && !undo) return;
      e.preventDefault();
      iframe.blur();
      window.focus();
      const { key, code, shiftKey, metaKey, ctrlKey } = e;
      window.dispatchEvent(new KeyboardEvent("keydown", { key, code, shiftKey, metaKey, ctrlKey, bubbles: true, cancelable: true }));
    });
    onSizedRef.current?.();
    return true;
  }, []);
  // ponytail: a frame-by-frame look for the parsed mail document, since a sandboxed frame without scripts has no
  // DOMContentLoaded the page can hear. It stops once found, at load, or when the mail changes.
  useEffect(() => {
    let frame = 0;
    const look = () => {
      const doc = iframeRef.current?.contentDocument;
      // The previous mail's document stays until the new one replaces it.
      if (doc && doc !== setUpRef.current && doc.URL === "about:srcdoc" && doc.readyState !== "loading" && setUp()) return;
      frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    const stop = () => cancelAnimationFrame(frame);
    const iframe = iframeRef.current;
    iframe?.addEventListener("load", stop);
    return () => {
      stop();
      iframe?.removeEventListener("load", stop);
    };
  }, [srcDoc, setUp]);
  // An image the app could not fetch is asked for by the mail's own page: a host that turns away whatever is not a
  // browser (vivo.com.br's Cloudflare answers the app with a challenge) still gives it to the web view. At the frame's
  // load, when every image has answered: a frame without scripts sends no image its error event.
  const handleFrameLoad = useCallback(() => {
    setUp();
    iframeRef.current?.contentDocument
      ?.querySelectorAll<HTMLImageElement>("img[data-web]")
      .forEach((img) => {
        if (img.complete && !img.naturalWidth) img.src = img.dataset.web!;
      });
  }, [setUp]);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const handleLoadImages = useCallback(() => {
    setOverrideShow(true);
  }, []);

  const handleAlwaysLoad = useCallback(async () => {
    if (accountId && senderAddress) {
      await addToAllowlist(accountId, senderAddress);
    }
    setOverrideShow(true);
  }, [accountId, senderAddress]);

  return (
    <div>
      {blocked && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs bg-bg-tertiary rounded-md border border-border-secondary">
          <ImageOff size={14} className="text-text-tertiary shrink-0" />
          <span className="text-text-secondary">
            Images hidden to protect your privacy.
          </span>
          <button
            onClick={handleLoadImages}
            className="text-accent hover:text-accent-hover font-medium"
          >
            Load images
          </button>
          {senderAddress && accountId && (
            <button
              onClick={handleAlwaysLoad}
              className="text-accent hover:text-accent-hover font-medium"
            >
              Always load from sender
            </button>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        data-email=""
        sandbox={MAIL_SANDBOX}
        srcDoc={srcDoc}
        onLoad={handleFrameLoad}
        title="Email content"
        className={`block w-full border-0 ${isDark && !isPlainText ? "rounded-md" : ""}`}
        style={{ colorScheme: scheme(isDark, isPlainText), overflow: "hidden" }}
      />
    </div>
  );
}

