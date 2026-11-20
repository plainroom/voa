import { normalizeEmail } from "@/utils/emailUtils";
import { getDb } from "./connection";

/** Addresses this account's owner blocked, already normalized. */
export async function getBlockedAddresses(accountId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ address: string }[]>("SELECT address FROM blocked_senders WHERE account_id = $1", [accountId]);
  return new Set(rows.map((r) => r.address));
}

/** Remember a sender so their mail stays out of the inbox. Empty addresses are ignored. */
export async function blockSender(accountId: string, address: string): Promise<void> {
  const normalized = normalizeEmail(address);
  if (!normalized) return;
  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO blocked_senders (account_id, address) VALUES ($1, $2)", [accountId, normalized]);
}

export async function unblockSender(accountId: string, address: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM blocked_senders WHERE account_id = $1 AND address = $2", [accountId, normalizeEmail(address)]);
}

export interface BlockedSenderRow {
  account_id: string;
  address: string;
}

/** Everyone the owner has blocked, on every account. */
export async function listBlockedSenders(): Promise<BlockedSenderRow[]> {
  const db = await getDb();
  return db.select<BlockedSenderRow[]>("SELECT account_id, address FROM blocked_senders ORDER BY address");
}

/** Conversations this block archived, so Unblock can put them back. */
export async function blockedThreadIdsFromSender(accountId: string, address: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    `SELECT DISTINCT m.thread_id AS id FROM messages m
     INNER JOIN thread_labels tl ON tl.account_id = m.account_id AND tl.thread_id = m.thread_id AND tl.label_id = 'BLOCKED'
     WHERE m.account_id = $1 AND lower(trim(m.from_address)) = $2`,
    [accountId, normalizeEmail(address)],
  );
  return rows.map((row) => row.id);
}

/** Inbox conversations whose latest message is from this sender. One where someone else wrote last is not theirs. */
export async function inboxThreadIdsFromSender(accountId: string, address: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    `SELECT DISTINCT t.id FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'INBOX'
     INNER JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1 AND lower(trim(m.from_address)) = $2`,
    [accountId, normalizeEmail(address)],
  );
  return rows.map((r) => r.id);
}

/**
 * The Message-ID of every message a block archived. A Message-ID survives a move (Outlook gives a moved message a
 * new id), so Unblock can find these again and return only them, never mail archived by hand.
 */
export async function recordBlockedMessages(accountId: string, address: string, messageIdHeaders: readonly string[]): Promise<void> {
  const db = await getDb();
  for (const header of messageIdHeaders) {
    await db.execute("INSERT OR IGNORE INTO blocked_messages (account_id, address, message_id_header) VALUES ($1, $2, $3)", [
      accountId,
      normalizeEmail(address),
      header,
    ]);
  }
}

export async function blockedMessageHeaders(accountId: string, address: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ message_id_header: string }[]>(
    "SELECT message_id_header FROM blocked_messages WHERE account_id = $1 AND address = $2",
    [accountId, normalizeEmail(address)],
  );
  return new Set(rows.map((row) => row.message_id_header));
}

/** Forgets the given Message-IDs of a block, or the whole record when none are given. */
export async function forgetBlockedMessages(accountId: string, address: string, messageIdHeaders?: readonly string[]): Promise<void> {
  const db = await getDb();
  if (!messageIdHeaders) {
    await db.execute("DELETE FROM blocked_messages WHERE account_id = $1 AND address = $2", [accountId, normalizeEmail(address)]);
    return;
  }
  for (const header of messageIdHeaders) {
    await db.execute("DELETE FROM blocked_messages WHERE account_id = $1 AND address = $2 AND message_id_header = $3", [
      accountId,
      normalizeEmail(address),
      header,
    ]);
  }
}
