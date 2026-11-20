import { getDb } from "../db/connection";
import { getSetting, setSetting } from "../db/settings";
import type { ThreadKey } from "../db/threads";
import { getGmailClient } from "../gmail/tokenManager";
import { addThreadLabel, archiveThread, removeThreadLabel, unarchiveThread, type ActionResult } from "../emailActions";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { createBackgroundChecker } from "../backgroundCheckers";

/**
 * Remind me: the thread is archived in Gmail and carries this label there, so a sync never brings
 * it back early and a lost database still knows which threads are waiting (`recoverOrphanSnoozes`).
 * The return time lives only here, in `threads.snooze_until`. Locally the thread also carries
 * `SNOOZED`, which only voa knows (the Snoozed list).
 */
export const SNOOZE_LABEL_NAME = "voa/Snoozed";
const LOCAL_LABEL = "SNOOZED";

const labelSetting = (accountId: string) => `snooze_label_id:${accountId}`;

function ok(result: ActionResult): void {
  if (!result.success) throw new Error(result.error ?? "Action failed");
}

/** The Gmail id of the voa label, found or created once and cached in settings. */
export async function ensureSnoozeLabel(accountId: string): Promise<string> {
  const cached = await getSetting(labelSetting(accountId));
  if (cached) return cached;
  const client = await getGmailClient(accountId);
  const { labels } = await client.listLabels();
  const label = labels.find((l) => l.name === SNOOZE_LABEL_NAME) ?? (await client.createLabel(SNOOZE_LABEL_NAME));
  await setSetting(labelSetting(accountId), label.id);
  return label.id;
}

/** The voa label could not be found or created (offline before the account's first snooze). */
export class SnoozeLabelUnavailable extends Error {
  constructor(readonly reason: unknown) {
    super("The voa snooze label is unavailable");
    this.name = "SnoozeLabelUnavailable";
  }
}

/** The voa label for a Gmail account; IMAP has no labels, so it gets none. */
async function snoozeLabelOf(accountId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ provider: string }[]>("SELECT provider FROM accounts WHERE id = $1", [accountId]);
  if (rows[0]?.provider !== "gmail_api") return null;
  try {
    return await ensureSnoozeLabel(accountId);
  } catch (err) {
    throw new SnoozeLabelUnavailable(err);
  }
}

async function setLocalSnooze(k: ThreadKey, until: number | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE threads SET is_snoozed = $1, snooze_until = $2 WHERE account_id = $3 AND id = $4", [
    until === null ? 0 : 1,
    until,
    k.accountId,
    k.threadId,
  ]);
  await db.execute(
    until === null
      ? "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3"
      : "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
    [k.accountId, k.threadId, LOCAL_LABEL],
  );
}

/** Whether Gmail still has this label (the owner may have deleted it there). */
async function labelExists(accountId: string, labelId: string): Promise<boolean> {
  const { labels } = await (await getGmailClient(accountId)).listLabels();
  return labels.some((l) => l.id === labelId);
}

/** Forgets a label id Gmail no longer has: the cache, if it is the one cached, and the thread's local copy. */
async function forgetLabel(k: ThreadKey, labelId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM settings WHERE key = $1 AND value = $2", [labelSetting(k.accountId), labelId]);
  await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3", [
    k.accountId,
    k.threadId,
    labelId,
  ]);
}

/**
 * Adds the voa label. When Gmail refuses an id it no longer has (the owner deleted the label),
 * the label is found or created again and the add retried once. A failure here is logged, not
 * thrown: the snooze still works on this Mac; only a lost database would forget it.
 */
async function labelThread(k: ThreadKey, label: string): Promise<void> {
  try {
    let result = await addThreadLabel(k.accountId, k.threadId, label);
    if (!result.success && !(await labelExists(k.accountId, label))) {
      await forgetLabel(k, label);
      result = await addThreadLabel(k.accountId, k.threadId, await ensureSnoozeLabel(k.accountId));
    }
    if (!result.success) console.error(`Remind me: could not label ${k.threadId}:`, result.error);
  } catch (err) {
    console.error(`Remind me: could not label ${k.threadId}:`, err);
  }
}

/** Snooze until `until` (unix seconds): archived in Gmail with the voa label, back in the inbox at that time. */
export async function remindLater(k: ThreadKey, messageIds: string[], until: number): Promise<void> {
  const db = await getDb();
  const current = await db.select<{ is_snoozed: number }[]>("SELECT is_snoozed FROM threads WHERE account_id = $1 AND id = $2", [
    k.accountId,
    k.threadId,
  ]);
  // Already snoozed (archived and labelled): only the time moves.
  if (current[0]?.is_snoozed === 1) return setLocalSnooze(k, until);

  const label = await snoozeLabelOf(k.accountId); // before any change: no label, no snooze
  // The time is written before Gmail sees the label, so a labelled thread without a time is always an orphan.
  await setLocalSnooze(k, until);
  const archived = await archiveThread(k.accountId, k.threadId, messageIds);
  if (!archived.success) {
    await setLocalSnooze(k, null);
    await db.execute("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')", [
      k.accountId,
      k.threadId,
    ]);
    ok(archived);
  }
  if (label) await labelThread(k, label);
}

/** Back to the inbox now, in Gmail too: INBOX restored (a queued archive is dropped), label and time gone. */
async function returnToInbox(k: ThreadKey, label: string | null): Promise<void> {
  await setLocalSnooze(k, null);
  ok(await unarchiveThread(k.accountId, k.threadId));
  if (!label) return;
  const removed = await removeThreadLabel(k.accountId, k.threadId, label);
  if (removed.success) return;
  // A label Gmail no longer has is not on the thread either: already removed.
  if (await labelExists(k.accountId, label)) ok(removed);
  await forgetLabel(k, label);
}

/** The undo of `remindLater`. */
export async function cancelRemind(k: ThreadKey, _messageIds: string[]): Promise<void> {
  await returnToInbox(k, await snoozeLabelOf(k.accountId));
}

/** Threads whose time has come go back to the inbox, in Gmail too. */
export async function checkSnoozedThreads(): Promise<void> {
  const db = await getDb();
  const due = await db.select<{ id: string; account_id: string }[]>(
    "SELECT id, account_id FROM threads WHERE is_snoozed = 1 AND snooze_until <= $1",
    [getCurrentUnixTimestamp()],
  );
  for (const t of due) {
    const k = { accountId: t.account_id, threadId: t.id };
    try {
      await returnToInbox(k, await snoozeLabelOf(k.accountId));
    } catch (err) {
      console.error(`Remind me: could not return ${t.id}:`, err);
    }
  }
  if (due.length > 0) window.dispatchEvent(new Event("voa-sync-done"));
}

/**
 * Threads that carry the voa label in Gmail but have no time here (the database was lost)
 * come back to the inbox now: woken early, never lost. Returns how many. voa assumes one install
 * per account (snoozes live on this Mac): a second install would take another's snoozes for orphans.
 */
export async function recoverOrphanSnoozes(): Promise<number> {
  const db = await getDb();
  const orphans = await db.select<{ account_id: string; thread_id: string; label_id: string }[]>(
    `SELECT tl.account_id, tl.thread_id, tl.label_id FROM thread_labels tl
     JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id
     JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
     WHERE l.name = $1 AND t.snooze_until IS NULL`,
    [SNOOZE_LABEL_NAME],
  );
  for (const o of orphans) {
    try {
      await returnToInbox({ accountId: o.account_id, threadId: o.thread_id }, o.label_id);
    } catch (err) {
      console.error(`Remind me: could not recover ${o.thread_id}:`, err);
    }
  }
  if (orphans.length > 0) window.dispatchEvent(new Event("voa-sync-done"));
  return orphans.length;
}

/**
 * Called by the Gmail sync after it wrote a thread's labels. Gmail showing a snoozed thread in
 * INBOX with the voa label still on it (a reply came, or it was moved back on the phone) ends
 * the snooze, and the label goes too. INBOX without the label is a read from before our archive
 * and label landed: the snooze stays, and the next sync sees the archive.
 */
export async function syncedSnooze(accountId: string, threadId: string, labelIds: string[]): Promise<void> {
  if (!labelIds.includes("INBOX")) return;
  const db = await getDb();
  const rows = await db.select<{ is_snoozed: number }[]>("SELECT is_snoozed FROM threads WHERE account_id = $1 AND id = $2", [
    accountId,
    threadId,
  ]);
  if (rows[0]?.is_snoozed !== 1) return;
  const label = await getSetting(labelSetting(accountId));
  if (!label || !labelIds.includes(label)) return;
  await setLocalSnooze({ accountId, threadId }, null);
  await removeThreadLabel(accountId, threadId, label);
}

const snoozeChecker = createBackgroundChecker("Snooze", checkSnoozedThreads);
export const startSnoozeChecker = snoozeChecker.start;
export const stopSnoozeChecker = snoozeChecker.stop;
