import { useState, useCallback, useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Reply, ReplyAll, Forward, Send } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { buildRawEmail } from "@/utils/emailBuilder";
import { getSetting } from "@/services/db/settings";
import type { DbMessage } from "@/services/db/messages";
import { forwardedHtml, replyRecipients, replyThreading, toBase64, type ReplyMode } from "./replyAddressing";
import { AddressInput } from "../compose/AddressInput";
import { getAttachmentsForMessage } from "@/services/db/attachments";
import { getEmailProvider } from "@/services/email/providerFactory";
import type { EmailAttachment } from "@/utils/emailBuilder";
import { flushPendingReply, REOPEN_EVENT, reopenReply, scheduleReply, takeReopenedReply, type OutgoingReply } from "./replySend";
import { getSignature, SignaturePreview, useSignature, withSignature } from "../compose/signature";
import { firstName } from "../ai/tasks/write";
import { Copilot, useCopilot } from "../compose/copilot";
import { thread as threadText } from "../ai/claude";
import { mailTables } from "../compose/BodyEditor";

/** Gmail is asked for the Message-ID at most this long: a hanging token refresh must not hold the send. */
export const HEADERS_TIMEOUT_MS = 10_000;

/** The RFC Message-ID and References of a message stored before voa kept them, read from Gmail once. */
async function threadingHeaders(accountId: string, m: DbMessage, provider: string | undefined): Promise<{ id: string | null; refs: string | null }> {
  if (m.message_id_header || provider === "imap") return { id: m.message_id_header, refs: m.references_header };
  const none = { id: null, refs: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      const { getGmailClient } = await import("@/services/gmail/tokenManager");
      const full = await (await getGmailClient(accountId)).getMessage(m.id, "metadata");
      const header = (name: string) => full.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
      return { id: header("message-id"), refs: header("references") };
    })();
    const timeout = new Promise<typeof none>((resolve) => (timer = setTimeout(() => resolve(none), HEADERS_TIMEOUT_MS)));
    return await Promise.race([read, timeout]);
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

/** The forwarded message's files, fetched from the account when the forward is sent. */
async function forwardedAttachments(accountId: string, m: DbMessage): Promise<EmailAttachment[]> {
  const files = (await getAttachmentsForMessage(accountId, m.id)).filter((a) => a.gmail_attachment_id);
  if (files.length === 0) return [];
  const provider = await getEmailProvider(accountId);
  return Promise.all(
    files.map(async (a) => ({
      filename: a.filename ?? "attachment",
      mimeType: a.mime_type ?? "application/octet-stream",
      content: toBase64((await provider.fetchAttachment(a.message_id, a.gmail_attachment_id!)).data),
    })),
  );
}

interface InlineReplyProps {
  /** Only its id is read. */
  thread: { id: string };
  messages: DbMessage[];
  accountId: string;
  noReply?: boolean;
  onSent: () => void;
}

export function InlineReply({ thread, messages, accountId, noReply, onSent }: InlineReplyProps) {
  const [mode, setMode] = useState<ReplyMode | null>(null);
  const [sending, setSending] = useState(false);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccount = accounts.find((a) => a.id === accountId);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => void (mountedRef.current = false);
  }, []);

  const lastMessage = messages[messages.length - 1];
  const signature = useSignature();

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, link: { openOnClick: false } }),
      mailTables,
      Placeholder.configure({
        placeholder: "Write your reply, or ⌘J to write it with Claude",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none px-3 py-2 min-h-[80px] max-h-[200px] overflow-y-auto focus:outline-none text-ink text-body",
      },
    },
  });

  const activateMode = useCallback((newMode: ReplyMode) => {
    setMode(newMode);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    // A forward starts at who it goes to (its field takes the focus); a reply at its words.
    if (newMode !== "forward") focusTimerRef.current = setTimeout(() => editor?.commands.focus(), 50);
  }, [editor]);

  // Listen for inline reply events from keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mode: ReplyMode } | undefined;
      if (detail?.mode) {
        activateMode(detail.mode);
      }
    };
    window.addEventListener("voa-inline-reply", handler);
    return () => window.removeEventListener("voa-inline-reply", handler);
  }, [activateMode]);

  // Scroll into view when activated
  useEffect(() => {
    if (mode && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [mode]);

  /** Who a forward goes to: the owner types it, since nobody in the conversation is its reader. */
  const [forwardTo, setForwardTo] = useState<string[]>([]);
  const getRecipients = useCallback(
    (): { to: string[]; cc: string[] } =>
      mode === "forward" ? { to: forwardTo, cc: [] } : mode ? replyRecipients(mode, lastMessage, activeAccount?.email) : { to: [], cc: [] },
    [lastMessage, mode, activeAccount?.email, forwardTo],
  );

  const getSubject = useCallback((): string => {
    const sub = lastMessage?.subject ?? "";
    if (mode === "forward") return sub.startsWith("Fwd:") ? sub : `Fwd: ${sub}`;
    return sub.startsWith("Re:") ? sub : `Re: ${sub}`;
  }, [lastMessage, mode]);

  // The reply answers the conversation: Claude reads it, and writes in its language.
  const copilot = useCopilot(
    editor,
    activeAccount,
    useCallback(() => ({ conversation: threadText(messages), to: firstName(messages[messages.length - 1]) }), [messages]),
  );


  const handleSend = useCallback(async () => {
    if (!activeAccount || !editor || sending || !mode) return;
    const { to, cc } = getRecipients();
    if (to.length === 0) return;

    setSending(true);
    try {
      const html = editor.getHTML();
      const subject = getSubject();
      const headers = mode === "forward" || !lastMessage ? { id: null, refs: null } : await threadingHeaders(accountId, lastMessage, activeAccount.provider);

      const raw = buildRawEmail({
        from: activeAccount.email,
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject,
        // The signature goes out with it, and a forward's message under it; the html kept for Undo is what was written.
        htmlBody: withSignature(html, await getSignature()) + (mode === "forward" && lastMessage ? forwardedHtml(lastMessage) : ""),
        attachments: mode === "forward" && lastMessage ? await forwardedAttachments(accountId, lastMessage) : undefined,
        ...replyThreading(headers.id, headers.refs),
        threadId: thread.id,
      });

      const delaySetting = await getSetting("undo_send_delay_seconds").catch(() => null);
      const delay = parseInt(delaySetting ?? "5", 10) * 1000;

      const reply: OutgoingReply = { accountId, threadId: thread.id, mode, raw, to, cc, subject, html, ...replyThreading(headers.id, headers.refs) };
      const sentMode = mode;
      // Scheduled (and saved) even when this conversation closed during the awaits above.
      void scheduleReply(reply, delay, (r) => {
        // Undo: the reply comes back as it was written, in a box that is gone reopened in its conversation.
        if (!mountedRef.current || editor.isDestroyed) return reopenReply(r);
        setMode(sentMode);
        if (sentMode === "forward") setForwardTo(r.to);
        editor.commands.setContent(r.html);
      });
      if (!mountedRef.current) return;

      editor.commands.setContent("");
      setForwardTo([]);
      setMode(null);
      onSent();
    } catch (err) {
      console.error("Failed to send:", err);
    } finally {
      setSending(false);
    }
  }, [activeAccount, editor, sending, getRecipients, getSubject, lastMessage, thread.id, accountId, mode, onSent]);

  // A reply reopened for this conversation (Open on "A reply wasn't sent", or Undo after it closed) comes back here.
  useEffect(() => {
    if (!editor) return;
    const take = () => {
      const r = takeReopenedReply(accountId, thread.id);
      if (!r) return;
      setMode(r.mode);
      editor.commands.setContent(r.html);
    };
    take();
    window.addEventListener(REOPEN_EVENT, take);
    return () => window.removeEventListener(REOPEN_EVENT, take);
  }, [editor, accountId, thread.id]);

  // A reply still in its Undo window when this conversation closes is sent now, not dropped.
  useEffect(() => () => void flushPendingReply(), []);

  // Cleanup focus timer on unmount
  useEffect(() => {
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, []);

  // Handle Ctrl+Enter to send, Escape to close
  useEffect(() => {
    if (!mode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        editor?.commands.setContent("");
        setMode(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, handleSend, editor]);

  if (!lastMessage) return null;

  // Collapsed state: three quiet actions, with their keys
  if (!mode) {
    const quiet =
      "inline-flex h-7 items-center gap-1.5 rounded-control px-2.5 text-body text-ink-2 transition-colors duration-(--vm-fast) hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2";
    const key = "text-meta text-ink-3";
    return (
      <div ref={containerRef} className="mx-4 mt-1 mb-2.5 flex items-center gap-1">
        <button onClick={() => activateMode("reply")} disabled={noReply} title={noReply ? "This sender does not accept replies" : undefined} className={quiet}>
          <Reply size={14} strokeWidth={1.75} />
          Reply <span className={key}>R</span>
        </button>
        <button onClick={() => activateMode("replyAll")} disabled={noReply} title={noReply ? "This sender does not accept replies" : undefined} className={quiet}>
          <ReplyAll size={14} strokeWidth={1.75} />
          Reply all <span className={key}>A</span>
        </button>
        <button onClick={() => activateMode("forward")} className={quiet}>
          <Forward size={14} strokeWidth={1.75} />
          Forward
        </button>
      </div>
    );
  }

  // Expanded state: editor visible
  const { to } = getRecipients();
  const modeLabel = mode === "reply" ? "Reply" : mode === "replyAll" ? "Reply All" : "Forward";

  return (
    <div
      ref={containerRef}
      onKeyDown={(e) => {
        copilot.key(e);
      }}
      className="mx-4 mt-3 mb-9 overflow-hidden rounded-panel border border-line bg-canvas"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {(["reply", "replyAll", "forward"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-control px-2 py-1 text-meta transition-colors duration-(--vm-fast) ${
                  mode === m ? "bg-selected font-medium text-ink" : "text-ink-3 hover:text-ink"
                }`}
              >
                {m === "reply" ? "Reply" : m === "replyAll" ? "Reply all" : "Forward"}
              </button>
            ))}
          </div>
          {mode !== "forward" && to.length > 0 && <span className="max-w-[260px] truncate text-meta text-ink-3">to {to.join(", ")}</span>}
        </div>
        <button onClick={() => setMode(null)} className="text-meta text-ink-3 transition-colors hover:text-ink">
          Cancel
        </button>
      </div>

      {mode === "forward" && (
        <div className="border-b border-line px-3">
          <AddressInput label="To" addresses={forwardTo} onChange={setForwardTo} placeholder="" autoFocus />
        </div>
      )}

      {/* Editor */}
      <div className="relative">
        <div className="px-3 pt-2.5">
          <Copilot editor={editor} copilot={copilot} />
        </div>
        <EditorContent editor={editor} />
        <div className="px-3">
          <SignaturePreview text={signature} />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end border-t border-line px-3 py-1.5">
        <button
          onClick={handleSend}
          disabled={sending || to.length === 0}
          className="inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-3 text-body font-medium text-canvas transition-opacity duration-(--vm-fast) hover:opacity-90 disabled:opacity-40"
        >
          <Send size={12} />
          {modeLabel} <span className="text-meta font-normal opacity-60">⌘↵</span>
        </button>
      </div>
    </div>
  );
}
