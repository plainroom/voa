import { getDb } from "./connection";

export interface DbMessage {
  id: string;
  account_id: string;
  thread_id: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  is_read: number;
  is_starred: number;
  body_html: string | null;
  body_text: string | null;
  body_cached: number;
  /** 1 while only the headers are stored (a search found it): the body is fetched when the conversation opens. */
  body_pending: number;
  /** 1 when the provider no longer has the body (gone, or never given after every try): shown as unavailable. */
  body_unavailable?: number;
  raw_size: number | null;
  internal_date: number | null;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  auth_results: string | null;
  message_id_header: string | null;
  references_header: string | null;
  in_reply_to_header: string | null;
  imap_uid: number | null;
  imap_folder: string | null;
}

export async function getMessagesForThread(
  accountId: string,
  threadId: string,
): Promise<DbMessage[]> {
  const db = await getDb();
  return db.select<DbMessage[]>(
    "SELECT * FROM messages WHERE account_id = $1 AND thread_id = $2 ORDER BY date ASC",
    [accountId, threadId],
  );
}

export async function upsertMessage(msg: {
  id: string;
  accountId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  bccAddresses: string | null;
  replyTo: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  rawSize: number | null;
  internalDate: number | null;
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
  authResults?: string | null;
  messageIdHeader?: string | null;
  referencesHeader?: string | null;
  inReplyToHeader?: string | null;
  imapUid?: number | null;
  imapFolder?: string | null;
  /** Only the headers came (a search's light fetch): the row waits for its body. A row that has one keeps it. */
  bodyPending?: boolean;
}): Promise<void> {
  const db = await getDb();
  // A headers-only row ($28) never erases what a fuller fetch stored: the stored value wins whenever it has one.
  const keep = (column: string, param: number) => `CASE WHEN $28 = 1 THEN COALESCE(${column}, $${param}) ELSE $${param} END`;
  await db.execute(
    `INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred, body_html, body_text, body_cached, raw_size, internal_date, list_unsubscribe, list_unsubscribe_post, auth_results, message_id_header, references_header, in_reply_to_header, imap_uid, imap_folder, body_pending)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
     ON CONFLICT(account_id, id) DO UPDATE SET
       from_address = ${keep("from_address", 4)}, from_name = ${keep("from_name", 5)},
       to_addresses = ${keep("to_addresses", 6)}, cc_addresses = ${keep("cc_addresses", 7)},
       bcc_addresses = ${keep("bcc_addresses", 8)}, reply_to = ${keep("reply_to", 9)},
       subject = ${keep("subject", 10)}, snippet = ${keep("snippet", 11)},
       date = $12, is_read = $13, is_starred = $14,
       body_html = COALESCE($15, body_html), body_text = COALESCE($16, body_text),
       body_cached = CASE WHEN $15 IS NOT NULL THEN 1 ELSE body_cached END,
       raw_size = ${keep("raw_size", 18)}, internal_date = ${keep("internal_date", 19)},
       list_unsubscribe = ${keep("list_unsubscribe", 20)}, list_unsubscribe_post = ${keep("list_unsubscribe_post", 21)},
       auth_results = ${keep("auth_results", 22)}, message_id_header = COALESCE($23, message_id_header),
       references_header = COALESCE($24, references_header),
       in_reply_to_header = COALESCE($25, in_reply_to_header),
       imap_uid = COALESCE($26, imap_uid), imap_folder = COALESCE($27, imap_folder),
       body_pending = CASE WHEN $15 IS NOT NULL OR $16 IS NOT NULL THEN 0
         WHEN $28 = 1 AND body_html IS NULL AND body_text IS NULL THEN 1 ELSE body_pending END`,
    [
      msg.id,
      msg.accountId,
      msg.threadId,
      msg.fromAddress,
      msg.fromName,
      msg.toAddresses,
      msg.ccAddresses,
      msg.bccAddresses,
      msg.replyTo,
      msg.subject,
      msg.snippet,
      msg.date,
      msg.isRead ? 1 : 0,
      msg.isStarred ? 1 : 0,
      msg.bodyHtml,
      msg.bodyText,
      msg.bodyHtml ? 1 : 0,
      msg.rawSize,
      msg.internalDate,
      msg.listUnsubscribe ?? null,
      msg.listUnsubscribePost ?? null,
      msg.authResults ?? null,
      msg.messageIdHeader ?? null,
      msg.referencesHeader ?? null,
      msg.inReplyToHeader ?? null,
      msg.imapUid ?? null,
      msg.imapFolder ?? null,
      msg.bodyPending ? 1 : 0,
    ],
  );
}

export async function deleteMessage(
  accountId: string,
  messageId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM messages WHERE account_id = $1 AND id = $2",
    [accountId, messageId],
  );
}

export async function messageThreadId(accountId: string, messageId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ thread_id: string }[]>(
    "SELECT thread_id FROM messages WHERE account_id = $1 AND id = $2",
    [accountId, messageId],
  );
  return rows[0]?.thread_id ?? null;
}

/** Times the Outlook sync asks for a body that does not come before it gives up on it. */
export const MAX_BODY_TRIES = 8;

/**
 * Messages stored without a body (its fetch failed) that the Outlook sync asks for again: the least tried first, then
 * the newest, so one that never comes cannot hold the others back; one tried `MAX_BODY_TRIES` times, or gone, is left.
 * Not a search's headers-only rows: their body is fetched only if the conversation is opened.
 */
export async function messageIdsWithoutBody(accountId: string, limit: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    `SELECT id FROM messages WHERE account_id = $1 AND body_html IS NULL AND body_text IS NULL AND body_pending = 0
       AND body_unavailable = 0 AND body_tries < $2 ORDER BY body_tries ASC, date DESC LIMIT $3`,
    [accountId, MAX_BODY_TRIES, limit],
  );
  return rows.map((row) => row.id);
}

/** Asked for and not given: one try more, and unavailable once the tries are spent. */
export async function noteBodyTry(accountId: string, messageId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE messages SET body_tries = body_tries + 1, body_unavailable = CASE WHEN body_tries + 1 >= $1 THEN 1 ELSE body_unavailable END WHERE account_id = $2 AND id = $3",
    [MAX_BODY_TRIES, accountId, messageId],
  );
}

/** The provider no longer has the message (moved, deleted, a stale id): no body will come. Not waiting for one either. */
export async function markBodyUnavailable(accountId: string, messageId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE messages SET body_unavailable = 1, body_pending = 0 WHERE account_id = $1 AND id = $2 AND body_html IS NULL AND body_text IS NULL",
    [accountId, messageId],
  );
}

/** The body a later fetch brought, and nothing else of the row. The row no longer waits for one, even when it is empty. */
export async function setMessageBody(accountId: string, messageId: string, bodyHtml: string | null, bodyText: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE messages SET body_html = $1, body_text = $2, body_cached = CASE WHEN $1 IS NOT NULL THEN 1 ELSE body_cached END, body_pending = 0, body_unavailable = 0 WHERE account_id = $3 AND id = $4",
    [bodyHtml, bodyText, accountId, messageId],
  );
}

/** The conversation's messages stored with headers only, waiting for their body. */
export async function pendingBodyIds(accountId: string, threadId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2 AND body_pending = 1",
    [accountId, threadId],
  );
  return rows.map((row) => row.id);
}

/** Graph gives a moved message a new id. The row, and the files on it, follow that id. */
export async function replaceMessageId(accountId: string, oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return;
  const db = await getDb();
  const rows = await db.select<Record<string, unknown>[]>("SELECT * FROM messages WHERE account_id = $1 AND id = $2", [
    accountId,
    oldId,
  ]);
  const row = rows[0];
  if (!row) return;
  const already = await db.select<{ id: string }[]>("SELECT id FROM messages WHERE account_id = $1 AND id = $2", [
    accountId,
    newId,
  ]);
  if (already[0]) {
    await db.execute("DELETE FROM messages WHERE account_id = $1 AND id = $2", [accountId, oldId]);
    return;
  }
  const copy: Record<string, unknown> = { ...row, id: newId };
  const columns = Object.keys(copy);
  await db.execute(
    `INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    columns.map((column) => copy[column]),
  );
  await db.execute("UPDATE attachments SET message_id = $1 WHERE account_id = $2 AND message_id = $3", [
    newId,
    accountId,
    oldId,
  ]);
  await db.execute("DELETE FROM messages WHERE account_id = $1 AND id = $2", [accountId, oldId]);
}

export async function updateMessageThreadIds(
  accountId: string,
  messageIds: string[],
  threadId: string,
): Promise<void> {
  const db = await getDb();
  // SQLite variable limit is 999; process in chunks
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500);
    const placeholders = chunk.map((_, idx) => `$${idx + 3}`).join(", ");
    await db.execute(
      `UPDATE messages SET thread_id = $1 WHERE account_id = $2 AND id IN (${placeholders})`,
      [threadId, accountId, ...chunk],
    );
  }
}

