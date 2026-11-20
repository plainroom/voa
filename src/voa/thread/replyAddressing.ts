import type { DbMessage } from "@/services/db/messages";
import { normalizeEmail } from "@/utils/emailUtils";
import { escapeHtml } from "@/utils/sanitize";

export type ReplyMode = "reply" | "replyAll" | "forward";

/** A header's address list ("A <a@x>, \"Doe, J\" <j@x>"), split on the commas outside quotes and angle brackets. */
export function splitAddresses(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The bare address of "Name <a@x>" or "a@x", lower-cased. */
function addressOf(entry: string): string {
  const angled = entry.match(/<([^>]+)>/);
  return normalizeEmail(angled ? angled[1]! : entry.replace(/"/g, ""));
}

/**
 * Who a reply goes to. Replying to a message the owner sent themself goes to that message's To
 * (and, for Reply all, its Cc), never back to the owner.
 */
export function replyRecipients(
  mode: ReplyMode,
  last: DbMessage | undefined,
  self: string | undefined,
): { to: string[]; cc: string[] } {
  if (!last || mode === "forward") return { to: [], cc: [] };
  const me = self ? normalizeEmail(self) : null;
  const notMe = (a: string) => addressOf(a) !== me;
  const fromMe =
    !!me && !!last.from_address && addressOf(last.from_address) === me;

  const direct = fromMe
    ? splitAddresses(last.to_addresses)
    : [last.reply_to ?? last.from_address].filter((a): a is string => !!a);
  if (mode === "reply") {
    // A note to self has no one else: it goes back to the owner.
    const others = fromMe ? direct.filter(notMe) : direct;
    return { to: dedupe(others.length > 0 ? others : direct), cc: [] };
  }

  const to = dedupe(
    [...direct, ...(fromMe ? [] : splitAddresses(last.to_addresses))].filter(
      notMe,
    ),
  );
  const cc = dedupe(splitAddresses(last.cc_addresses).filter(notMe)).filter(
    (a) => !to.some((t) => addressOf(t) === addressOf(a)),
  );
  return { to, cc };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = addressOf(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** In-Reply-To and References for a reply to `last`: its RFC Message-ID, never Gmail's internal id. */
export function replyThreading(
  messageIdHeader: string | null | undefined,
  referencesHeader: string | null | undefined,
): { inReplyTo?: string; references?: string } {
  const id = messageIdHeader?.trim();
  if (!id) return {};
  const refs = referencesHeader?.trim();
  return { inReplyTo: id, references: refs ? `${refs} ${id}` : id };
}

/**
 * What a forward carries under the owner's words: the forwarded message's header, as Gmail writes it,
 * then its body. Without it a forward sent only the words typed above it.
 */
export function forwardedHtml(m: DbMessage): string {
  const row = (name: string, value: string | null | undefined) => (value ? `${name}: ${escapeHtml(value)}<br>` : "");
  const from = m.from_name && m.from_name !== m.from_address ? `${m.from_name} <${m.from_address}>` : m.from_address;
  const date = new Date(m.date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const body = m.body_html ?? `<pre>${escapeHtml(m.body_text ?? "")}</pre>`;
  return `<br><div>---------- Forwarded message ---------<br>${row("From", from)}${row("Date", date)}${row("Subject", m.subject)}${row("To", m.to_addresses)}${row("Cc", m.cc_addresses)}</div><br>${body}`;
}

/** An attachment's data as plain base64, which a raw message carries: Gmail hands it url-safe and unpadded. */
export function toBase64(data: string): string {
  const b = data.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}
