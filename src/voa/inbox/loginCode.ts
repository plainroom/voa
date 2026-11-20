const CUE =
  /(?:verification|login|security|one-time) code|c[oó]digo de verifica[cç][aã]o|c[oó]digo de valida[cç][aã]o|c[oó]digo de acesso|c[oó]digo abaixo|[eé] o seu c[oó]digo/gi;

const TOKEN = /\b(\d{4,8}|[A-Z][A-Z0-9]{5,9})\b/g;

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

/**
 * The one code worth copying, or null.
 * A phrase has to say it is a login or verification code. The token closest to that phrase wins:
 * 4 to 8 digits, or 6 to 10 uppercase letters and digits. Years are not codes.
 * ponytail: no body scan past what the caller passes. Callers pass the snippet plus plainHead.
 */
export function loginCode(text: string): string | null {
  const clean = text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "");
  const cues = [...clean.matchAll(CUE)];
  if (cues.length === 0) return null;

  let best: { code: string; dist: number } | null = null;
  let bestDigits: { code: string; dist: number } | null = null;
  for (const token of clean.matchAll(TOKEN)) {
    const code = token[1];
    if (!code || YEAR.test(code)) continue;
    const start = token.index ?? 0;
    const end = start + code.length;
    for (const cue of cues) {
      const cueStart = cue.index ?? 0;
      const cueEnd = cueStart + cue[0].length;
      if (start < cueEnd && end > cueStart) continue;
      const dist = start >= cueEnd ? start - cueEnd : cueStart - end;
      if (!best || dist < best.dist) best = { code, dist };
      if (/^\d+$/.test(code) && (!bestDigits || dist < bestDigits.dist)) bestDigits = { code, dist };
    }
  }
  // A heading in all caps (ENTRAR) can sit closer to the phrase than the digits.
  if (best && bestDigits && !/\d/.test(best.code) && bestDigits.dist <= best.dist + 16) return bestDigits.code;
  return best?.code ?? null;
}
