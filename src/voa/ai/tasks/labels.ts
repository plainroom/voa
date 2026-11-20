import { getDb } from "@/services/db/connection";
import { getSetting } from "@/services/db/settings";
import { normalizeEmail } from "@/utils/emailUtils";
import { isNoReplyAddress } from "@/utils/noReply";
import { ask, ofMessage, type Mail, type Shape, type Task } from "../apple";

/** The labels a mail can get: what each one takes in, as the model is told and Settings shows. */
export const KINDS = [
  { id: "personal", help: "A person writing to you" },
  { id: "work", help: "A colleague, client or partner about work" },
  { id: "meeting", help: "Scheduling or a calendar invitation" },
  { id: "news", help: "Newsletters and digests" },
  { id: "marketing", help: "Promotions and sales" },
  { id: "pitch", help: "Cold sales outreach from someone you do not know" },
  { id: "login", help: "Codes, password resets and security alerts" },
  { id: "invoice", help: "Bills, receipts and payment notices" },
  { id: "travel", help: "Bookings, tickets and itineraries" },
  { id: "notification", help: "Automatic notices from apps and services" },
] as const;

export type Kind = (typeof KINDS)[number]["id"];

/** What labeling found in a conversation's newest message: its kind, and whether it waits for the owner's reply. */
export type Labels = { kind: Kind | null; respond: boolean };

const IS_KIND = new Set<string>(KINDS.map((k) => k.id));

export function checkLabels(answer: unknown): Labels | null {
  if (!answer || typeof answer !== "object") return null;
  const raw = answer as { kind?: unknown; respond?: unknown };
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  // A kind the model made up is no label; its respond still counts.
  return { kind: IS_KIND.has(kind) ? (kind as Kind) : null, respond: raw.respond === true };
}

const shape = (type: "string" | "boolean", name: string, description: string): Shape => ({ type, name, description });

/**
 * One label per mail, and "respond" apart: asked one yes or no per label, the model said yes to most
 * (a newsletter came out news, marketing, pitch and respond at once).
 */
export const labels: Task<Labels> = {
  id: "labels",
  // 2: what version 1 stored as nothing was a failure (a refusal, a busy model), asked again.
  version: 2,
  instructions: "You sort one email for the person who received it: the one label that fits it best, and whether it waits for their reply.",
  schema: {
    type: "object",
    properties: [
      shape("string", "kind", `The one label that fits best, one of: ${KINDS.map((k) => `${k.id} (${k.help.toLowerCase()})`).join(", ")}`),
      shape(
        "boolean",
        "respond",
        "True only if a person asks the reader personally for a reply, a decision or an action; false for any automatic or mass message",
      ),
    ],
  },
  check: checkLabels,
};

/** The settings row of the labels the owner turned off (Settings > Labels); none means the default. */
export const LABELS_OFF = "ai_labels_off";
/** Off until turned on: the two the model read least well on the owner's mail. */
export const DEFAULT_OFF: readonly string[] = ["pitch", "notification"];

export async function labelsOff(): Promise<Set<string>> {
  const raw = await getSetting(LABELS_OFF);
  try {
    return new Set(raw ? (JSON.parse(raw) as string[]) : DEFAULT_OFF);
  } catch {
    return new Set(DEFAULT_OFF);
  }
}

type Newest = Mail & { from_address: string | null; list_unsubscribe: string | null };

/** The newest message of every inbox conversation. */
const NEWEST = `
  SELECT m.id, m.account_id, m.thread_id, m.body_html, m.body_text, m.from_address, m.list_unsubscribe, m.body_pending
  FROM messages m
  JOIN thread_labels tl ON tl.account_id = m.account_id AND tl.thread_id = m.thread_id AND tl.label_id = 'INBOX'
  WHERE m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = m.account_id AND m2.thread_id = m.thread_id)`;

/** The owner's own addresses, every account's, lower case: a conversation they wrote last waits for no one's reply. */
async function ownAddresses(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ email: string }[]>("SELECT email FROM accounts UNION SELECT email FROM send_as_aliases");
  return new Set(rows.map((r) => normalizeEmail(r.email)));
}

/**
 * A reply is asked of the owner only by a person, so these never wait for one, whatever the model
 * says: a no-reply sender, a mailing list (List-Unsubscribe). The rule, not a guess at the words.
 */
const canAsk = (m: Pick<Newest, "from_address" | "list_unsubscribe">) => !isNoReplyAddress(m.from_address) && !m.list_unsubscribe;

let passing = false;

/**
 * Labels, one at a time, the newest message of every inbox conversation that has not been labeled yet;
 * one the owner wrote is skipped (it waits for no one). Runs after each sync, after the cards' tasks.
 * Says so (`voa-labels`) when it labeled something, so the lists show it.
 */
export async function labelAhead(): Promise<void> {
  if (passing) return;
  passing = true;
  try {
    const db = await getDb();
    const own = await ownAddresses();
    const todo = await db.select<(Newest & { body_pending: number })[]>(
      `${NEWEST} AND NOT EXISTS (SELECT 1 FROM ai_cache c WHERE c.account_id = m.account_id AND c.thread_id = m.thread_id AND c.type = $1 || m.id) ORDER BY m.date DESC`,
      [`${labels.id}/${labels.version}:`],
    );
    let labeled = 0;
    for (const m of todo) {
      if (m.body_pending === 1 || (m.body_html == null && m.body_text == null)) continue;
      if (m.from_address && own.has(normalizeEmail(m.from_address))) continue;
      const found = await ask(labels, ofMessage(m)).catch((err: unknown) => {
        console.warn("ai labels failed", err);
        return null; // asked again next sync
      });
      if (found === undefined) break; // no model on this Mac: stop until the next sync
      if (found) labeled++;
    }
    if (labeled) window.dispatchEvent(new Event("voa-labels"));
  } finally {
    passing = false;
  }
}

/** The labels of every inbox conversation, by `<account>:<thread>`: its newest message's, with the rule above on respond. */
export async function inboxLabels(): Promise<Map<string, Labels>> {
  const db = await getDb();
  const rows = await db.select<{ account_id: string; thread_id: string; content: string; from_address: string | null; list_unsubscribe: string | null }[]>(
    `SELECT m.account_id, m.thread_id, c.content, m.from_address, m.list_unsubscribe FROM (${NEWEST}) m
     JOIN ai_cache c ON c.account_id = m.account_id AND c.thread_id = m.thread_id AND c.type = $1 || m.id`,
    [`${labels.id}/${labels.version}:`],
  );
  const out = new Map<string, Labels>();
  for (const r of rows) {
    const l = JSON.parse(r.content) as Labels | null;
    if (l) out.set(`${r.account_id}:${r.thread_id}`, { kind: l.kind, respond: l.respond && canAsk(r) });
  }
  return out;
}
