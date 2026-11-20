const STEM = /(?<![\p{L}\p{N}])(?:c[oó]digo|code)(?![\p{L}\p{N}])/giu;
const DIGITS = /\b(\d{4,8})\b/g;
const LETTERS = /\b([A-Z][A-Z0-9]{5,9})\b/g;

const YEAR = /^(?:19|20)\d{2}$/;

/**
 * Text the detector is allowed to see.
 * Plain mail is already short. HTML (Outlook, and the Gmail rows that never got a text body)
 * loses its style, script and tags, then stops at 480 characters so a newsletter cannot
 * smuggle a phrase in from the bottom.
 * ponytail: tag strip, not a parser. A code past 16KB of markup or past 480 characters of text is missed.
 */
export function plainHead(raw: string | null | undefined): string {
  if (!raw) return "";
  if (!raw.includes("<")) return raw.slice(0, 480);
  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits);
      return code > 0 && code < 128 ? String.fromCharCode(code) : " ";
    })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
  return text.slice(0, 480);
}

type Span = { start: number; end: number };

function stems(text: string): Span[] {
  return [...text.matchAll(STEM)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** The digit token closest to "código" or "code". A year is not a code. */
function nearestDigits(text: string, words: Span[]): string | null {
  let best: { code: string; dist: number } | null = null;
  for (const token of text.matchAll(DIGITS)) {
    const code = token[1];
    if (!code || YEAR.test(code)) continue;
    const start = token.index ?? 0;
    const end = start + code.length;
    for (const word of words) {
      const dist = start >= word.end ? start - word.end : word.start - end;
      if (!best || dist < best.dist) best = { code, dist };
    }
  }
  return best?.code ?? null;
}

/**
 * An uppercase token, when the word sits against it or a colon introduces it.
 * "off code ... SLOPCOURSE" has neither, so a discount code stays out.
 */
function letterCode(text: string, words: Span[]): string | null {
  let best: { code: string; dist: number } | null = null;
  for (const token of text.matchAll(LETTERS)) {
    const code = token[1];
    if (!code) continue;
    const start = token.index ?? 0;
    const end = start + code.length;
    for (const word of words) {
      const gap = start >= word.end ? text.slice(word.end, start) : text.slice(end, word.start);
      const colonAt = gap.lastIndexOf(":");
      const afterColon = start >= word.end && colonAt >= 0 && !/[\p{L}\p{N}]/u.test(gap.slice(colonAt + 1));
      if (/[\p{L}\p{N}]/u.test(gap) && !afterColon) continue;
      if (!best || gap.length < best.dist) best = { code, dist: gap.length };
    }
  }
  return best?.code ?? null;
}

/**
 * The one code worth copying, or null.
 * The mail has to say "código" or "code". The number closest to that word wins:
 * 4 to 8 digits, or, when there are none, 6 to 10 uppercase letters and digits
 * stuck to the word or introduced by a colon. Years are not codes.
 * ponytail: no body scan past what the caller passes. Callers pass the snippet plus plainHead.
 */
export function loginCode(text: string): string | null {
  const clean = text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "");
  const words = stems(clean);
  if (words.length === 0) return null;
  return nearestDigits(clean, words) ?? letterCode(clean, words);
}
