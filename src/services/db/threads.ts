import { getDb } from "./connection";

export interface DbThread {
  id: string;
  account_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: number | null;
  message_count: number;
  is_read: number;
  is_starred: number;
  is_important: number;
  has_attachments: number;
  is_snoozed: number;
  snooze_until: number | null;
  is_pinned: number;
  is_muted: number;
  from_name: string | null;
  from_address: string | null;
  /** Latest-message text for the login-code chip. Only `getThreads` fills this: the text part, and the HTML head only for an unread thread (a code is for the one you have not opened). */
  body_head?: string | null;
}

export type ThreadKey = { accountId: string; threadId: string };

type UnifiedLabel = "INBOX" | "STARRED" | "SNOOZED" | "SPAM" | "TRASH" | "DONE";

/**
 * Done: no label of its own, what is in none of the lists. A conversation that left the inbox, with a message
 * someone else sent (one only the owner wrote was never in it), and not in Spam, Trash or Snoozed.
 */
const DONE = `NOT EXISTS (
  SELECT 1 FROM thread_labels x WHERE x.account_id = t.account_id AND x.thread_id = t.id AND x.label_id IN ('INBOX', 'SPAM', 'TRASH', 'SNOOZED')
) AND EXISTS (
  SELECT 1 FROM messages rm WHERE rm.account_id = t.account_id AND rm.thread_id = t.id
    AND lower(rm.from_address) NOT IN (SELECT lower(email) FROM accounts UNION SELECT lower(email) FROM send_as_aliases)
)`;

/** Threads carrying `labelId` across accounts (all when `accountIds` is undefined), newest first. */
/** Whether the conversation is starred: the one answer every screen and action asks, never the list it was opened from. */
export const isStarred = (thread: Pick<DbThread, "is_starred"> | undefined): boolean => thread?.is_starred === 1;

export async function getThreads(opts: {
  labelId: UnifiedLabel;
  accountIds?: string[];
  limit?: number;
  offset?: number;
}): Promise<DbThread[]> {
  const db = await getDb();
  const { labelId, accountIds, limit = 50, offset = 0 } = opts;
  const params: unknown[] = [labelId];
  let accountFilter = "";
  if (accountIds) {
    accountFilter = `AND t.account_id IN (${accountIds.map((_, i) => `$${i + 2}`).join(", ")})`;
    params.push(...accountIds);
  }
  params.push(limit, offset);
  // A blocked sender stays out of the inbox even when a sync writes the INBOX label back.
  // Gmail's Promotions category leaves the inbox list. The mail stays in INBOX at Gmail.
  const hideBlocked = labelId === "INBOX" ? `${BLOCKED_SENDER} ${NOT_PROMOTION}` : "";
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address,
       CASE
         WHEN m.body_text IS NOT NULL AND length(trim(m.body_text)) > 0 THEN substr(m.body_text, 1, 480)
         WHEN t.is_read = 0 THEN substr(m.body_html, 1, 16384)
       END AS body_head
     FROM threads t
     ${labelId === "DONE" ? "" : "INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id"}
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE ${labelId === "DONE" ? `$1 = 'DONE' AND ${DONE}` : "tl.label_id = $1"} ${accountFilter} ${hideBlocked} ${labelId === "TRASH" ? "" : NOT_TRASH}
     GROUP BY t.account_id, t.id
     ORDER BY t.last_message_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

/** Drops an inbox row whose latest message is from a blocked sender. Takes the columns holding the row's account and thread. */
const blockedSender = (account: string, thread: string) => `AND NOT EXISTS (
  SELECT 1 FROM messages bm
  INNER JOIN blocked_senders bs ON bs.account_id = bm.account_id AND bs.address = lower(trim(bm.from_address))
  WHERE bm.account_id = ${account} AND bm.thread_id = ${thread}
    AND bm.date = (SELECT MAX(lm.date) FROM messages lm WHERE lm.account_id = ${account} AND lm.thread_id = ${thread})
)`;

const BLOCKED_SENDER = blockedSender("t.account_id", "t.id");
const BLOCKED_SENDER_COUNT = blockedSender("tl.account_id", "tl.thread_id");

/** Gmail's Promotions tab. The thread still carries INBOX. */
const NOT_PROMOTION = `AND NOT EXISTS (
  SELECT 1 FROM thread_labels pl
  WHERE pl.account_id = t.account_id AND pl.thread_id = t.id AND pl.label_id = 'CATEGORY_PROMOTIONS'
)`;

const NOT_PROMOTION_COUNT = `AND NOT EXISTS (
  SELECT 1 FROM thread_labels pl
  WHERE pl.account_id = tl.account_id AND pl.thread_id = tl.thread_id AND pl.label_id = 'CATEGORY_PROMOTIONS'
)`;

/** A deleted thread stays out of every list but Trash. */
const NOT_TRASH = `AND NOT EXISTS (
  SELECT 1 FROM thread_labels tr
  WHERE tr.account_id = t.account_id AND tr.thread_id = t.id AND tr.label_id = 'TRASH'
)`;

const NOT_TRASH_COUNT = `AND NOT EXISTS (
  SELECT 1 FROM thread_labels tr
  WHERE tr.account_id = tl.account_id AND tr.thread_id = tl.thread_id AND tr.label_id = 'TRASH'
)`;

/** Thread count per account id for `labelId`. */
export async function getLabelCounts(
  labelId: UnifiedLabel,
): Promise<Record<string, number>> {
  if (labelId === "DONE") return {}; // what was cleared is no count to clear
  const db = await getDb();
  const hideBlocked = labelId === "INBOX" ? `${BLOCKED_SENDER_COUNT} ${NOT_PROMOTION_COUNT}` : "";
  const rows = await db.select<{ account_id: string; count: number }[]>(
    `SELECT tl.account_id, COUNT(*) AS count FROM thread_labels tl WHERE tl.label_id = $1 ${hideBlocked} ${labelId === "TRASH" ? "" : NOT_TRASH_COUNT} GROUP BY tl.account_id`,
    [labelId],
  );
  return Object.fromEntries(rows.map((r) => [r.account_id, r.count]));
}

/** Inbox threads Gmail filed as Promotions, newest first. */
export async function getPromotionThreads(limit = 500): Promise<DbThread[]> {
  const db = await getDb();
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'INBOX'
     INNER JOIN thread_labels pl ON pl.account_id = t.account_id AND pl.thread_id = t.id AND pl.label_id = 'CATEGORY_PROMOTIONS'
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE 1 = 1 ${BLOCKED_SENDER} ${NOT_TRASH}
     GROUP BY t.account_id, t.id
     ORDER BY t.last_message_at DESC
     LIMIT $1`,
    [limit],
  );
}

export async function upsertThread(thread: {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(account_id, id) DO UPDATE SET
       subject = $3, snippet = $4, last_message_at = $5, message_count = $6,
       is_read = $7, is_starred = $8, is_important = $9, has_attachments = $10`,
    [
      thread.id,
      thread.accountId,
      thread.subject,
      thread.snippet,
      thread.lastMessageAt,
      thread.messageCount,
      thread.isRead ? 1 : 0,
      thread.isStarred ? 1 : 0,
      thread.isImportant ? 1 : 0,
      thread.hasAttachments ? 1 : 0,
    ],
  );
}

export async function setThreadLabels(
  accountId: string,
  threadId: string,
  labelIds: string[],
): Promise<void> {
  const db = await getDb();
  // SNOOZED and BLOCKED exist only in voa. A provider sync must not wipe them.
  await db.execute(
    "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id NOT IN ('SNOOZED', 'BLOCKED')",
    [accountId, threadId],
  );
  // Insert new labels
  for (const labelId of labelIds) {
    await db.execute(
      "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
      [accountId, threadId, labelId],
    );
  }
}

/** A label only this app understands. The provider is not told. */
export async function addLocalLabel(accountId: string, threadId: string, labelId: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)", [
    accountId,
    threadId,
    labelId,
  ]);
}

export async function removeLocalLabel(accountId: string, threadId: string, labelId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3", [
    accountId,
    threadId,
    labelId,
  ]);
}

export async function getThreadLabelIds(
  accountId: string,
  threadId: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  return rows.map((r) => r.label_id);
}

export async function getThreadById(
  accountId: string,
  threadId: string,
): Promise<DbThread | undefined> {
  const db = await getDb();
  const rows = await db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1 AND t.id = $2
     LIMIT 1`,
    [accountId, threadId],
  );
  return rows[0];
}

export async function getThreadCountForAccount(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM threads WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.count ?? 0;
}

/** Unread threads the inbox list shows (the Dock badge): no blocked sender, no promotion, nothing deleted. */
export async function getUnreadInboxCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     WHERE tl.label_id = 'INBOX' AND t.is_read = 0 ${BLOCKED_SENDER_COUNT} ${NOT_PROMOTION_COUNT} ${NOT_TRASH_COUNT}`,
  );
  return rows[0]?.count ?? 0;
}

/** Unread threads the inbox list shows whose newest message came after `since` (ms), with that message's sender: the new-mail notifications. */
export async function getUnreadInboxSince(
  since: number,
): Promise<Pick<DbThread, "account_id" | "id" | "subject" | "last_message_at" | "from_name" | "from_address">[]> {
  const db = await getDb();
  return db.select(
    `SELECT t.account_id, t.id, t.subject, t.last_message_at, m.from_name, m.from_address FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE tl.label_id = 'INBOX' AND t.is_read = 0 AND t.last_message_at > $1 ${BLOCKED_SENDER_COUNT} ${NOT_PROMOTION_COUNT} ${NOT_TRASH_COUNT}
     GROUP BY t.account_id, t.id
     ORDER BY t.last_message_at`,
    [since],
  );
}

export async function deleteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM threads WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

/** The ids of an account's threads carrying `labelId`. */
export async function threadIdsWithLabel(accountId: string, labelId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ thread_id: string }[]>("SELECT thread_id FROM thread_labels WHERE account_id = $1 AND label_id = $2", [accountId, labelId]);
  return rows.map((r) => r.thread_id);
}
