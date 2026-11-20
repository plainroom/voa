import { invoke } from "@tauri-apps/api/core";
import type { DbMessage } from "@/services/db/messages";

/** Where the default target language is kept: the last one picked. */
export const TRANSLATE_TO = "translate_to";

/** The languages offered, as macOS's translation names them. */
export const LANGUAGES = [
  "pt-BR",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "ja",
  "zh-Hans",
];

const names = new Intl.DisplayNames(["en"], { type: "language" });
export const languageName = (code: string) => names.of(code) ?? code;

/** Why a message was left as it was: already in that language, a pair the Mac has not downloaded, one it cannot translate, a language it cannot tell. */
export type NotTranslated = "same" | "download" | "unsupported" | "unknown";

export type Translation = { from: string | null } & (
  { html: string | null; text: string | null } | { why: NotTranslated }
);

async function translateTexts(
  texts: string[],
  to: string,
): Promise<{ from: string | null; texts?: string[]; why?: NotTranslated }> {
  return JSON.parse(
    await invoke<string>("ai_ask", {
      request: JSON.stringify({ translate: texts, to }),
    }),
  );
}

/** The html with each piece of text translated in place, so the mail keeps its look. */
export async function translateHtml(
  html: string,
  translate: (texts: string[]) => Promise<string[] | null>,
): Promise<string | null> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue?.trim() && !n.parentElement?.closest("style, script")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const out = await translate(nodes.map((n) => n.nodeValue ?? ""));
  if (!out) return null;
  nodes.forEach((n, i) => (n.nodeValue = out[i] ?? n.nodeValue));
  return doc.documentElement.outerHTML;
}

/** Plain text by paragraph: a line broken at 72 columns is still one sentence. */
export async function translateText(
  text: string,
  translate: (texts: string[]) => Promise<string[] | null>,
): Promise<string | null> {
  const parts = text.split(/(\n\s*\n)/);
  const which = parts
    .map((_, i) => i)
    .filter((i) => i % 2 === 0 && parts[i]?.trim());
  const out = await translate(which.map((i) => parts[i] ?? ""));
  if (!out) return null;
  which.forEach((i, k) => (parts[i] = out[k] ?? parts[i] ?? ""));
  return parts.join("");
}

// ponytail: kept for the app's life, a message's translation never changes. Only one that worked: a pair downloaded later translates.
const done = new Map<string, Translation>();

/** A message's body in another language, by macOS's own translation (on the Mac, no model). */
export async function translateMessage(
  m: DbMessage,
  to: string,
): Promise<Translation> {
  const key = `${m.id}:${to}`;
  const kept = done.get(key);
  if (kept) return kept;
  let from: string | null = null;
  let why: NotTranslated | undefined;
  const translate = async (texts: string[]) => {
    if (texts.length === 0) return texts;
    const r = await translateTexts(texts, to);
    from = r.from;
    why = r.why;
    return r.texts ?? null;
  };
  const html = m.body_html ? await translateHtml(m.body_html, translate) : null;
  const text =
    !m.body_html && m.body_text
      ? await translateText(m.body_text, translate)
      : null;
  const result: Translation = why ? { from, why } : { from, html, text };
  if (!why) done.set(key, result);
  return result;
}
