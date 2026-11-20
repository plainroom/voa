import { clearAccountHistoryId } from "./accounts";
import { getDb } from "./connection";

/**
 * An Outlook full delta pass (the first sync, or one after Microsoft dropped the cursor). It may take several runs:
 * meanwhile history_id stays null, as for a Gmail account still in its first sync, the pass's next link lives in
 * accounts.graph_next_link, and the inbox threads it saw in graph_pass_seen.
 */

/** A pass from the start: no next link, nothing seen yet. The same reset a resync does. */
export async function startGraphPass(accountId: string): Promise<void> {
  await clearAccountHistoryId(accountId);
}

export async function saveGraphPassLink(accountId: string, nextLink: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE accounts SET graph_next_link = $1, last_sync_at = unixepoch(), updated_at = unixepoch() WHERE id = $2", [
    nextLink,
    accountId,
  ]);
}

export async function markGraphPassSeen(accountId: string, threadIds: Iterable<string>): Promise<void> {
  const db = await getDb();
  for (const threadId of threadIds) {
    await db.execute("INSERT OR IGNORE INTO graph_pass_seen (account_id, thread_id) VALUES ($1, $2)", [accountId, threadId]);
  }
}

/**
 * The pass reached the end of the feed. A thread the local inbox still shows that the pass never saw there left the
 * inbox while voa was not following (local only: nothing is moved in Outlook). Then the delta link becomes the
 * cursor and the pass's state is dropped.
 */
export async function finishGraphPass(accountId: string, deltaLink: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM thread_labels WHERE account_id = $1 AND label_id = 'INBOX'
       AND thread_id NOT IN (SELECT thread_id FROM graph_pass_seen WHERE account_id = $1)`,
    [accountId],
  );
  await db.execute(
    "UPDATE accounts SET history_id = $1, graph_next_link = NULL, last_sync_at = unixepoch(), updated_at = unixepoch() WHERE id = $2",
    [deltaLink, accountId],
  );
  await db.execute("DELETE FROM graph_pass_seen WHERE account_id = $1", [accountId]);
}
