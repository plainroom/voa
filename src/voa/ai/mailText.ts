/** A mail as the model reads it: its text (up to the model's context), each link written "[link N]" and kept here. */
export type MailText = { text: string; links: string[] };

// ponytail: the on-device model's context is about 4k tokens; what a mail is about sits near its top.
export const MAX = 6000;

// Invisible characters (format controls, the soft hyphens and joiners newsletters pad their preview with) say nothing and fill the model's context.
const squash = (s: string) =>
  s
    .replace(/[\p{Cf}\u034f]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX);

/**
 * `replyOnly` drops what a reply quotes of the messages before it (Gmail's quote, a blockquote,
 * "> " lines), for a reader that has those messages already: a conversation's summary.
 */
export function mailText(html: string | null, text: string | null, replyOnly = false): MailText {
  if (!html) {
    const lines = (text ?? "").split("\n");
    return { text: squash((replyOnly ? lines.filter((l) => !l.startsWith(">")) : lines).join("\n")), links: [] };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(replyOnly ? "style, script, head, blockquote, .gmail_quote" : "style, script, head").forEach((n) => n.remove());
  const links: string[] = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:/i.test(href) || !a.textContent?.trim()) return;
    links.push(href);
    a.append(` [link ${links.length}] `);
  });
  // Block elements end a line, so "Itinerário" and the date do not run into one word.
  doc.querySelectorAll("p, div, td, tr, li, br, h1, h2, h3, h4").forEach((n) => n.append(" "));
  return { text: squash(doc.body?.textContent ?? ""), links };
}
