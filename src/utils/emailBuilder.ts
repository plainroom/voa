/**
 * Build an RFC 2822 email message and encode as base64url for the Gmail API.
 */
export interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: string; // base64-encoded content
}

export interface EmailDraft {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  htmlBody: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  attachments?: EmailAttachment[];
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A header value as mail allows it: ASCII as is, anything else as UTF-8 encoded words (RFC 2047), each
 * on its own folded line. Written raw, Gmail read "Relatório" as "RelatÃ³rio".
 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  // At most 45 bytes a word (60 in base64, under the 75 a word may take), cut between characters.
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

/** Reads back what `encodeHeader` wrote (its words, folded or not); anything else as it is. */
export function decodeHeader(value: string): string {
  const words = value.match(/=\?UTF-8\?B\?[^?]*\?=/g);
  if (!words || words.join(" ") !== value.replace(/\s+/g, " ").trim()) return value;
  return words.map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).join("");
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function buildAlternativePart(boundary: string, htmlBody: string): string[] {
  const textContent = htmlToPlainText(htmlBody);
  const lines: string[] = [];

  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(textContent);
  lines.push("");

  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/html; charset=UTF-8");
  lines.push("");
  lines.push(htmlBody);
  lines.push("");

  lines.push(`--${boundary}--`);
  return lines;
}

interface InlineImage {
  cid: string;
  mimeType: string;
  base64: string;
}

/**
 * Extract base64 data URLs from HTML and replace with cid: references.
 * Returns the modified HTML and extracted inline images.
 */
function extractInlineImages(html: string): { html: string; images: InlineImage[] } {
  const images: InlineImage[] = [];
  const processed = html.replace(
    /<img([^>]*)\ssrc="data:([^;]+);base64,([^"]+)"([^>]*)>/g,
    (_match, before: string, mime: string, data: string, after: string) => {
      const cid = `inline_${Date.now()}_${images.length}@voa`;
      images.push({ cid, mimeType: mime, base64: data });
      return `<img${before} src="cid:${cid}"${after}>`;
    },
  );
  return { html: processed, images };
}

/**
 * Generate a unique Message-ID for outgoing emails.
 */
function generateMessageId(from: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  const domain = from.includes("@") ? from.split("@")[1] : "voa.local";
  return `<${timestamp}.${random}@${domain}>`;
}

export function buildRawEmail(draft: EmailDraft): string {
  const messageId = generateMessageId(draft.from);
  const lines: string[] = [
    `From: ${draft.from}`,
    `To: ${draft.to.join(", ")}`,
  ];

  if (draft.cc && draft.cc.length > 0) {
    lines.push(`Cc: ${draft.cc.join(", ")}`);
  }
  if (draft.bcc && draft.bcc.length > 0) {
    lines.push(`Bcc: ${draft.bcc.join(", ")}`);
  }

  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push(`Subject: ${encodeHeader(draft.subject)}`);
  lines.push(`MIME-Version: 1.0`);

  if (draft.inReplyTo) {
    lines.push(`In-Reply-To: ${draft.inReplyTo}`);
  }
  if (draft.references) {
    lines.push(`References: ${draft.references}`);
  }

  const { html: processedHtml, images: inlineImages } = extractInlineImages(draft.htmlBody);
  const hasAttachments = draft.attachments && draft.attachments.length > 0;
  const hasInlineImages = inlineImages.length > 0;

  if (hasAttachments || hasInlineImages) {
    const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const relatedBoundary = `----=_Related_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (hasAttachments) {
      lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
      lines.push("");

      lines.push(`--${mixedBoundary}`);
    }

    if (hasInlineImages) {
      lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
      lines.push("");

      lines.push(`--${relatedBoundary}`);
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(...buildAlternativePart(altBoundary, processedHtml));
      lines.push("");

      // Inline image parts
      for (const img of inlineImages) {
        lines.push(`--${relatedBoundary}`);
        lines.push(`Content-Type: ${img.mimeType}`);
        lines.push("Content-Transfer-Encoding: base64");
        lines.push(`Content-ID: <${img.cid}>`);
        lines.push("Content-Disposition: inline");
        lines.push("");
        for (let i = 0; i < img.base64.length; i += 76) {
          lines.push(img.base64.slice(i, i + 76));
        }
        lines.push("");
      }
      lines.push(`--${relatedBoundary}--`);
    } else {
      // No inline images, just alternative
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(...buildAlternativePart(altBoundary, processedHtml));
    }

    if (hasAttachments) {
      lines.push("");
      // Attachment parts
      for (const att of draft.attachments!) {
        lines.push(`--${mixedBoundary}`);
        lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
        lines.push("Content-Transfer-Encoding: base64");
        lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        lines.push("");
        const raw = att.content;
        for (let i = 0; i < raw.length; i += 76) {
          lines.push(raw.slice(i, i + 76));
        }
        lines.push("");
      }
      lines.push(`--${mixedBoundary}--`);
    }
  } else {
    const altBoundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push("");
    lines.push(...buildAlternativePart(altBoundary, processedHtml));
  }

  return base64UrlEncode(lines.join("\r\n"));
}

export interface ParsedRawEmail {
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string;
}

/** What `buildRawEmail` wrote, read back: recipients, subject, threading and the HTML body (inline images stay `cid:` links). */
export function parseRawEmail(rawBase64Url: string): ParsedRawEmail {
  const base = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base + "=".repeat((4 - (base.length % 4)) % 4));
  const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))).replace(/\r\n/g, "\n");
  const headerEnd = text.indexOf("\n\n");
  // A folded header (a long encoded Subject) goes on in the lines that start with a space.
  const headers = (headerEnd === -1 ? text : text.slice(0, headerEnd)).replace(/\n[ \t]/g, " ");
  const header = (name: string) => headers.split("\n").find((line) => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  const list = (name: string) =>
    header(name)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
  // The HTML part runs from its header to the next line of its own boundary, which is the line just above that header.
  const marker = "\nContent-Type: text/html; charset=UTF-8\n\n";
  const start = text.indexOf(marker);
  let html = "";
  if (start !== -1) {
    const boundary = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
    const body = text.slice(start + marker.length);
    const end = body.indexOf(`\n${boundary}`);
    html = (end === -1 ? body : body.slice(0, end)).replace(/\n$/, "");
  }
  return {
    to: list("to"),
    cc: list("cc"),
    subject: decodeHeader(header("subject")),
    html,
    ...(header("in-reply-to") ? { inReplyTo: header("in-reply-to") } : {}),
    ...(header("references") ? { references: header("references") } : {}),
  };
}
