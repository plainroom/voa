import { GmailClient } from "./client";
import { GmailNotFoundError, GmailRateLimitError } from "./quota";
import { parseGmailMessage, type ParsedMessage } from "./messageParser";
import { upsertLabel } from "../db/labels";
import { addLocalLabel, upsertThread, setThreadLabels } from "../db/threads";
import { setMessageBody, upsertMessage } from "../db/messages";
import { upsertAttachment } from "../db/attachments";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import { deleteSetting, getSetting, setSetting } from "../db/settings";
import { getThreadById, deleteThread } from "../db/threads";
import { getBlockedAddresses } from "../db/blockedSenders";
import { normalizeEmail } from "@/utils/emailUtils";
import { getPendingOpsForResource } from "../db/pendingOperations";

export interface SyncProgress {
  phase: "labels" | "threads" | "messages" | "done";
  current: number;
  total: number;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

/**
 * Store a fetched thread's data (messages, labels, attachments) into the local DB.
 * A search stores read-only (`search`): headers only, the labels exactly as Gmail has them, and nothing that changes
 * a mailbox: no auto-archive, no blocked-sender drop, no snooze ended, no request to Gmail.
 */
async function processAndStoreThread(
  thread: { id: string },
  accountId: string,
  parsedMessages: ParsedMessage[],
  client?: GmailClient,
  search = false,
): Promise<void> {
  const lastMessage = parsedMessages[parsedMessages.length - 1]!;
  const firstMessage = parsedMessages[0]!;

  const allLabelIds = new Set<string>();
  for (const msg of parsedMessages) {
    for (const lid of msg.labelIds) {
      allLabelIds.add(lid);
    }
  }

  const isRead = parsedMessages.every((m) => m.isRead);
  const isStarred = parsedMessages.some((m) => m.isStarred);
  const isImportant = allLabelIds.has("IMPORTANT");
  const hasAttachments = parsedMessages.some((m) => m.hasAttachments);

  await upsertThread({
    id: thread.id,
    accountId,
    subject: firstMessage.subject,
    snippet: lastMessage.snippet,
    lastMessageAt: lastMessage.date,
    messageCount: parsedMessages.length,
    isRead,
    isStarred,
    isImportant,
    hasAttachments,
  });

  await setThreadLabels(accountId, thread.id, [...allLabelIds]);

  // Gmail showing a snoozed thread in INBOX ends its snooze.
  if (!search) {
    const { syncedSnooze } = await import("@/services/snooze/snoozeManager");
    await syncedSnooze(accountId, thread.id, [...allLabelIds]);
  }

  await Promise.all(parsedMessages.map(async (parsed) => {
    await upsertMessage({
      id: parsed.id,
      accountId,
      threadId: parsed.threadId,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      bccAddresses: parsed.bccAddresses,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      snippet: parsed.snippet,
      date: parsed.date,
      isRead: parsed.isRead,
      isStarred: parsed.isStarred,
      bodyHtml: parsed.bodyHtml,
      bodyText: parsed.bodyText,
      rawSize: parsed.rawSize,
      internalDate: parsed.internalDate,
      listUnsubscribe: parsed.listUnsubscribe,
      listUnsubscribePost: parsed.listUnsubscribePost,
      authResults: parsed.authResults,
      messageIdHeader: parsed.messageIdHeader,
      referencesHeader: parsed.referencesHeader,
      bodyPending: search,
    });

    await Promise.all(parsed.attachments.map((att) =>
      upsertAttachment({
        id: `${parsed.id}_${att.gmailAttachmentId}`,
        messageId: parsed.id,
        accountId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        gmailAttachmentId: att.gmailAttachmentId,
        contentId: att.contentId,
        isInline: att.isInline,
      }),
    ));
  }));

  if (!search) await dropBlockedFromInbox(accountId, thread.id, lastMessage.fromAddress, allLabelIds, client);
}

/**
 * A blocked sender's new mail leaves the inbox, the same way a muted thread does. Only when the latest message is
 * theirs: a conversation where someone else wrote last stays. BLOCKED marks it, so Unblock brings it back.
 */
async function dropBlockedFromInbox(
  accountId: string,
  threadId: string,
  latestFrom: string | null | undefined,
  labelIds: Set<string>,
  client?: GmailClient,
): Promise<void> {
  if (!labelIds.has("INBOX") || !latestFrom) return;
  const blocked = await getBlockedAddresses(accountId);
  if (!blocked.has(normalizeEmail(latestFrom))) return;
  labelIds.delete("INBOX");
  await setThreadLabels(accountId, threadId, [...labelIds]);
  await addLocalLabel(accountId, threadId, "BLOCKED");
  if (!client) return;
  try {
    await client.modifyThread(threadId, undefined, ["INBOX"]);
  } catch (err) {
    console.error(`Failed to drop a blocked sender from the inbox (${threadId}):`, err);
  }
}

/**
 * Sync all labels for an account.
 */
async function syncLabels(
  client: GmailClient,
  accountId: string,
): Promise<{ id: string; name: string }[]> {
  const response = await client.listLabels();
  await Promise.all(response.labels.map((label) =>
    upsertLabel({
      id: label.id,
      accountId,
      name: label.name,
      type: label.type,
      colorBg: label.color?.backgroundColor ?? null,
      colorFg: label.color?.textColor ?? null,
    }),
  ));
  return response.labels;
}

/** Where a first sync's backfill keeps the day it reads back to, until it has read everything. */
const backfillKey = (accountId: string) => `gmail_backfill_after:${accountId}`;

/** The backfill running for each account, so a resume never starts a second one. */
const backfills = new Map<string, Promise<void>>();

/**
 * Initial sync: the inbox, the starred and the snoozed threads first, whatever their age, then the
 * account counts as synced (its history id stored) and the rest of the last `daysBack` days comes in
 * the background (`continueBackfill`). The history id is the profile's, read before anything else,
 * so the delta sync picks up whatever changes while the threads are fetched.
 */
export async function initialSync(
  client: GmailClient,
  accountId: string,
  daysBack = 365,
  onProgress?: SyncProgressCallback,
): Promise<void> {
  onProgress?.({ phase: "labels", current: 0, total: 1 });
  const labels = await syncLabels(client, accountId);
  onProgress?.({ phase: "labels", current: 1, total: 1 });

  const { historyId } = await client.getProfile();

  const seen = new Set<string>();
  const threadIds: string[] = [];
  onProgress?.({ phase: "threads", current: 0, total: 0 });
  const listInto = async (params: { labelIds: string[] }) => {
    for (const id of await listThreadIds(client, params)) {
      if (seen.has(id)) continue;
      seen.add(id);
      threadIds.push(id);
    }
    onProgress?.({ phase: "threads", current: threadIds.length, total: threadIds.length });
  };
  // Without the inbox an old thread still in it never shows, and the inbox reads "All clear." when it is not.
  await listInto({ labelIds: ["INBOX"] });
  await listInto({ labelIds: ["STARRED"] });
  // Sent is not in the inbox, and search only sees what is stored.
  await listInto({ labelIds: ["SENT"] });
  // Spam is a quiet list (g then p); without this pass /spam stays empty after a fresh install.
  await listInto({ labelIds: ["SPAM"] });
  // Trash too (g then t), so a deletion can be reviewed. Gmail empties it after 30 days.
  await listInto({ labelIds: ["TRASH"] });
  const { SNOOZE_LABEL_NAME } = await import("@/services/snooze/snoozeManager");
  const snoozeLabel = labels.find((l) => l.name === SNOOZE_LABEL_NAME);
  if (snoozeLabel) await listInto({ labelIds: [snoozeLabel.id] });
  let progress = 0;
  let failed = 0;
  // The first pass at full speed (it is small); what Gmail still refused for the quota is read again, paced.
  const rateLimited = await inRounds(threadIds, async (id, background) => {
    if (!background) onProgress?.({ phase: "messages", current: ++progress, total: threadIds.length });
    try {
      const thread = await client.getThread(id, "full", { background });
      if (!thread.messages || thread.messages.length === 0) return;
      await processAndStoreThread(thread, accountId, thread.messages.map(parseGmailMessage), client);
    } catch (err) {
      if (err instanceof GmailRateLimitError) throw err;
      failed++;
      console.error(`Failed to sync thread ${id}:`, err);
    }
  }, INITIAL_CONCURRENCY);

  // A thread of the inbox left out would never show: the sync is not complete, and is tried again.
  if (rateLimited.length > 0) {
    throw new GmailRateLimitError(`Gmail's quota left ${rateLimited.length} conversations unread`);
  }

  // Nothing could be fetched: not a completed sync (it is tried again, and the account shows the error).
  if (threadIds.length > 0 && failed === threadIds.length) {
    throw new Error("Could not fetch any conversation");
  }

  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - daysBack);
  await setSetting(backfillKey(accountId), `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`);
  await updateAccountSyncState(accountId, historyId);

  // A full sync after a lost database brings the voa-labelled threads back without their time:
  // they return to the inbox now, not at the next launch.
  const { recoverOrphanSnoozes } = await import("@/services/snooze/snoozeManager");
  await recoverOrphanSnoozes().catch((err) => console.error("Remind me: recovery failed:", err));

  // Initial already listed these; skip the one-shot catch-up on the next delta.
  await setSetting(spamCatchupKey(accountId), "1");
  await setSetting(trashCatchupKey(accountId), "1");
  await setSetting(sentCatchupKey(accountId), "1");

  onProgress?.({ phase: "done", current: threadIds.length, total: threadIds.length });

  void continueBackfill(client, accountId);
}

export const spamCatchupKey = (accountId: string) => `spam_listed_v1:${accountId}`;
const trashCatchupKey = (accountId: string) => `trash_listed_v1:${accountId}`;
export const sentCatchupKey = (accountId: string) => `sent_listed_v1:${accountId}`;

/**
 * One-shot for accounts that synced before Spam (or Trash) was a list: list the label and store any thread
 * still missing locally. Retries on the next sync if Gmail's quota cuts it short.
 */
export async function catchUpSpam(client: GmailClient, accountId: string, label: "SPAM" | "TRASH" = "SPAM"): Promise<void> {
  const key = label === "SPAM" ? spamCatchupKey(accountId) : trashCatchupKey(accountId);
  if ((await getSetting(key)) === "1") return;
  const ids = await listThreadIds(client, { labelIds: [label] }, { background: true });
  const rateLimited = await inRounds(
    ids,
    async (id, background) => {
      if ((await getThreadById(accountId, id)) !== undefined) return;
      if ((await getPendingOpsForResource(accountId, id)).length > 0) return;
      try {
        const thread = await client.getThread(id, "full", { background });
        if (!thread.messages || thread.messages.length === 0) return;
        await processAndStoreThread(
          thread,
          accountId,
          thread.messages.map(parseGmailMessage),
          client,
        );
      } catch (err) {
        if (err instanceof GmailRateLimitError) throw err;
        console.error(`Failed to catch up ${label} thread ${id}:`, err);
      }
    },
    BACKFILL_CONCURRENCY,
  );
  if (rateLimited.length > 0) return;
  await setSetting(key, "1");
}

/**
 * One-shot for accounts that synced before Sent was listed: store sent threads still missing
 * locally, so a search can find mail that left the inbox. Retries if the quota cuts it short.
 */
export async function catchUpSent(client: GmailClient, accountId: string): Promise<void> {
  if ((await getSetting(sentCatchupKey(accountId))) === "1") return;
  const ids = await listThreadIds(client, { labelIds: ["SENT"] }, { background: true });
  const rateLimited = await inRounds(
    ids,
    async (id, background) => {
      if ((await getThreadById(accountId, id)) !== undefined) return;
      if ((await getPendingOpsForResource(accountId, id)).length > 0) return;
      try {
        const thread = await client.getThread(id, "full", { background });
        if (!thread.messages || thread.messages.length === 0) return;
        await processAndStoreThread(
          thread,
          accountId,
          thread.messages.map(parseGmailMessage),
          client,
        );
      } catch (err) {
        if (err instanceof GmailRateLimitError) throw err;
        console.error(`Failed to catch up sent thread ${id}:`, err);
      }
    },
    BACKFILL_CONCURRENCY,
  );
  if (rateLimited.length > 0) return;
  await setSetting(sentCatchupKey(accountId), "1");
}

/**
 * Search includes archived mail. Gmail answers the query (one page) and any conversation not stored yet is
 * stored with its headers and snippet, so the local index can find it. Already stored threads are skipped,
 * and an aborted search stops asking.
 */
export async function storeQueryThreads(client: GmailClient, accountId: string, query: string, signal?: AbortSignal): Promise<void> {
  const q = query.trim();
  if (!q) return;
  // The user is waiting on these: they spend quota as foreground requests.
  const response = await client.listThreads({ maxResults: 20, q });
  const ids = (response.threads ?? []).map((t) => t.id);
  await inRounds(
    ids,
    async (id, background) => {
      if (signal?.aborted) return;
      if ((await getThreadById(accountId, id)) !== undefined) return;
      if ((await getPendingOpsForResource(accountId, id)).length > 0) return;
      try {
        // Headers and snippet only: the body comes when the conversation opens (`fetchGmailBodies`).
        const thread = await client.getThread(id, "metadata", { background });
        if (!thread.messages || thread.messages.length === 0 || signal?.aborted) return;
        await processAndStoreThread(thread, accountId, thread.messages.map(parseGmailMessage), undefined, true);
      } catch (err) {
        if (err instanceof GmailRateLimitError) throw err;
        console.error(`Failed to store search thread ${id}:`, err);
      }
    },
    BACKFILL_CONCURRENCY,
  );
}

/** The bodies and files of a conversation a search stored with headers only. Nothing else of the rows changes. */
export async function fetchGmailBodies(client: GmailClient, accountId: string, threadId: string): Promise<void> {
  const thread = await client.getThread(threadId, "full");
  for (const parsed of (thread.messages ?? []).map(parseGmailMessage)) {
    await setMessageBody(accountId, parsed.id, parsed.bodyHtml, parsed.bodyText);
    for (const att of parsed.attachments) {
      await upsertAttachment({
        id: `${parsed.id}_${att.gmailAttachmentId}`,
        messageId: parsed.id,
        accountId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        gmailAttachmentId: att.gmailAttachmentId,
        contentId: att.contentId,
        isInline: att.isInline,
      });
    }
  }
}

/**
 * Reads the rest of a first sync's days, if any is left (a restart in the middle resumes it), without
 * holding the sync: it only adds threads not stored yet, so a delta sync running beside it, which
 * stores what changed, always wins. Resolves when the account's backfill is over.
 */
export function continueBackfill(client: GmailClient, accountId: string): Promise<void> {
  const running = backfills.get(accountId);
  if (running) return running;
  const run = backfill(client, accountId)
    .catch((err) => console.error(`Backfill failed for ${accountId}, tried again at the next sync:`, err))
    .finally(() => backfills.delete(accountId));
  backfills.set(accountId, run);
  return run;
}

async function backfill(client: GmailClient, accountId: string): Promise<void> {
  const after = await getSetting(backfillKey(accountId));
  if (!after) return;
  const threadIds = await listThreadIds(client, { q: `after:${after}` }, { background: true });
  // Stored already (the first part of the sync, a delta sync, an earlier run), or the user is acting on it.
  const skip = async (id: string) =>
    (await getThreadById(accountId, id)) !== undefined || (await getPendingOpsForResource(accountId, id)).length > 0;
  let removed = false;
  const rateLimited = await inRounds(threadIds, async (id) => {
    if (removed) return;
    if (!(await getAccount(accountId))) {
      removed = true;
      return;
    }
    if (await skip(id)) return;
    try {
      const thread = await client.getThread(id, "full", { background: true });
      if (!thread.messages || thread.messages.length === 0) return;
      if (await skip(id)) return;
      await processAndStoreThread(thread, accountId, thread.messages.map(parseGmailMessage), client);
    } catch (err) {
      if (err instanceof GmailRateLimitError) throw err;
      console.error(`Failed to backfill thread ${id}:`, err);
    }
  }, BACKFILL_CONCURRENCY);
  if (removed) return;
  // What the quota kept out is read at the next sync's resume, which skips what is stored.
  if (rateLimited.length > 0) {
    console.warn(`Backfill for ${accountId}: ${rateLimited.length} conversations left for the next sync (Gmail's quota)`);
    return;
  }
  await deleteSetting(backfillKey(accountId));
}

/** The first sync and the delta sync read with this many requests at once; the backfill, paced by the quota, with this many. */
const INITIAL_CONCURRENCY = 10;
const BACKFILL_CONCURRENCY = 3;
const RATE_LIMIT_ROUNDS = 3;

/**
 * Runs `task` over `ids`, then again, paced (`background`), over those it threw a `GmailRateLimitError`
 * for, up to `RATE_LIMIT_ROUNDS` passes. Resolves with the ids the quota still kept out; any other
 * error is the task's to handle.
 */
async function inRounds(
  ids: string[],
  task: (id: string, background: boolean) => Promise<void>,
  concurrency: number,
): Promise<string[]> {
  let remaining = ids;
  for (let round = 0; round < RATE_LIMIT_ROUNDS && remaining.length > 0; round++) {
    const background = round > 0;
    const refused: string[] = [];
    await parallelLimit(
      remaining.map((id) => async () => {
        try {
          await task(id, background);
        } catch (err) {
          if (!(err instanceof GmailRateLimitError)) throw err;
          refused.push(id);
        }
      }),
      background ? BACKFILL_CONCURRENCY : concurrency,
    );
    remaining = refused;
  }
  return remaining;
}

async function listThreadIds(
  client: GmailClient,
  params: { q?: string; labelIds?: string[] },
  opts: { background?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.listThreads({ maxResults: 100, pageToken, ...params }, opts);
    for (const t of response.threads ?? []) ids.push(t.id);
    pageToken = response.nextPageToken;
  } while (pageToken);
  return ids;
}

/**
 * Delta sync: fetch only changes since last sync using history API.
 */
/**
 * Process a batch of promises with limited concurrency.
 */
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

/**
 * Delta sync: fetch only changes since last sync using history API.
 */
/** True when something changed, so the list reloads. An idle history check returns false. */
export async function deltaSync(
  client: GmailClient,
  accountId: string,
  lastHistoryId: string,
): Promise<boolean> {
  try {
    // Paginate through all history pages
    const affectedThreadIds = new Set<string>();
    let latestHistoryId = lastHistoryId;
    let pageToken: string | undefined;

    do {
      const response = await client.getHistory(lastHistoryId, undefined, pageToken);
      latestHistoryId = response.historyId;

      if (response.history) {
        for (const item of response.history) {
          if (item.messagesAdded) {
            for (const added of item.messagesAdded) {
              affectedThreadIds.add(added.message.threadId);
            }
          }
          if (item.messagesDeleted) {
            for (const deleted of item.messagesDeleted) {
              affectedThreadIds.add(deleted.message.threadId);
            }
          }
          if (item.labelsAdded) {
            for (const labeled of item.labelsAdded) {
              affectedThreadIds.add(labeled.message.threadId);
            }
          }
          if (item.labelsRemoved) {
            for (const unlabeled of item.labelsRemoved) {
              affectedThreadIds.add(unlabeled.message.threadId);
            }
          }
        }
      }

      pageToken = response.nextPageToken;
    } while (pageToken);

    if (affectedThreadIds.size === 0) {
      await updateAccountSyncState(accountId, latestHistoryId);
      return false;
    }

    // Re-fetch affected threads in parallel; what Gmail's quota refused is read again, paced, and if it still
    // is the history id stays where it was, so the next sync reads those changes again instead of losing them.
    const threadIds = [...affectedThreadIds];
    const rateLimited = await inRounds(threadIds, async (threadId, background) => {
      try {
        // Skip metadata overwrite for threads with pending local changes
        const pendingOps = await getPendingOpsForResource(accountId, threadId);
        if (pendingOps.length > 0) {
          console.log(`[deltaSync] Skipping thread ${threadId}: has ${pendingOps.length} pending local ops`);
          return;
        }

        const thread = await client.getThread(threadId, "full", { background });

        if (!thread.messages || thread.messages.length === 0) return;

        const parsedMessages = thread.messages.map(parseGmailMessage);
        await processAndStoreThread(thread, accountId, parsedMessages, client);
      } catch (err) {
        if (err instanceof GmailRateLimitError) throw err;
        // Deleted at Gmail (Spam and Trash empty themselves after 30 days): gone here too.
        if (err instanceof GmailNotFoundError) return deleteThread(accountId, threadId);
        console.error(`Failed to re-sync thread ${threadId}:`, err);
      }
    }, INITIAL_CONCURRENCY);

    if (rateLimited.length > 0) {
      throw new GmailRateLimitError(`Gmail's quota left ${rateLimited.length} changed conversations unread`);
    }

    await updateAccountSyncState(accountId, latestHistoryId);
    return true;
  } catch (err) {
    if (err instanceof GmailRateLimitError) throw err;
    // historyId might be too old: need full re-sync
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("historyId")) {
      console.warn("History ID expired, triggering full re-sync");
      throw new Error("HISTORY_EXPIRED");
    }
    throw err;
  }
}
