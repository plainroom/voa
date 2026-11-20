import { getDb } from "@/services/db/connection";
import { getSetting } from "@/services/db/settings";
import type { DbMessage } from "@/services/db/messages";
import { mailText } from "../mailText";

/** Settings > Writing: whether a few replies the owner sent show the model their voice, and what they say of how they write. */
export const WRITING_LEARN = "ai_writing_learn";
export const WRITING_NOTE = "ai_writing";
/** The note until the owner saves their own (an empty one saved stays empty). */
const DEFAULT_WRITING_NOTE = "Short and direct.\nAlways write in the same language as the email";

/** The sender's first name, or "" when they gave none: a name that is their address is no name. */
export function firstName(m: { from_name: string | null; from_address: string | null } | undefined): string {
  const name = (m?.from_name ?? "").trim();
  return name && !name.includes("@") ? (name.split(/\s+/)[0] ?? "") : "";
}

/** A few short replies the owner sent from this account, newest first, without what they quote: their voice. */
export async function ownReplies(accountId: string, ownAddress: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<Pick<DbMessage, "body_html" | "body_text">[]>(
    // Replies only (Re:): what the owner wrote to someone, not what voa sent for them (an invitation's answer).
    `SELECT body_html, body_text FROM messages WHERE account_id = $1 AND lower(from_address) = lower($2) AND subject LIKE 'Re:%'
       AND (body_text IS NOT NULL OR body_html IS NOT NULL) ORDER BY date DESC LIMIT 20`,
    [accountId, ownAddress],
  );
  // ponytail: length is the one filter (a short reply is a voice; a long one is content that fills the context).
  return rows
    .map((r) => mailText(r.body_html, r.body_text, true).text)
    .filter((t) => t.length >= 30 && t.length <= 400)
    .slice(0, 3);
}

/** The first name an address's own mail gives, newest first: a new email greets them by it. "" when none does. */
export async function nameOf(address: string): Promise<string> {
  const db = await getDb();
  const rows = await db.select<Pick<DbMessage, "from_name" | "from_address">[]>(
    "SELECT from_name, from_address FROM messages WHERE lower(from_address) = lower($1) AND from_name IS NOT NULL ORDER BY date DESC LIMIT 1",
    [address],
  );
  return firstName(rows[0]);
}

/** Settings > Writing, read once per request. */
export async function writingSettings(): Promise<{ learn: boolean; note: string }> {
  const [learn, note] = await Promise.all([getSetting(WRITING_LEARN), getSetting(WRITING_NOTE)]);
  return { learn: learn !== "false", note: (note ?? DEFAULT_WRITING_NOTE).trim() };
}
