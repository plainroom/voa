import { useUIStore } from "@/stores/uiStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import {
  enqueuePendingOperation,
  deleteOperation,
  deletePendingOperations,
  updateOperationStatus,
} from "@/services/db/pendingOperations";
import { classifyError, retriesSafely } from "@/utils/networkErrors";
import { getDb } from "@/services/db/connection";
import { updateBadgeCount } from "@/services/badgeManager";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EmailAction =
  | { type: "archive"; threadId: string; messageIds: string[] }
  | { type: "trash"; threadId: string; messageIds: string[] }
  | { type: "permanentDelete"; threadId: string; messageIds: string[] }
  | {
      type: "markRead";
      threadId: string;
      messageIds: string[];
      read: boolean;
    }
  | {
      type: "star";
      threadId: string;
      messageIds: string[];
      starred: boolean;
    }
  | {
      type: "spam";
      threadId: string;
      messageIds: string[];
      isSpam: boolean;
    }
  | {
      type: "moveToFolder";
      threadId: string;
      messageIds: string[];
      folderPath: string;
    }
  | { type: "addLabel"; threadId: string; labelId: string }
  | { type: "removeLabel"; threadId: string; labelId: string }
  | {
      type: "sendMessage";
      rawBase64Url: string;
      threadId?: string;
      /** The saved reply this send is (`pending_reply:` row id), so its notice can tell this row from another reply's. */
      replyId?: string;
    };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  queued?: boolean;
  /** A send whose outcome is unknown (it may have gone): not queued, never sent again by itself. */
  uncertain?: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Local DB updates (so offline reads reflect changes)
// ---------------------------------------------------------------------------

async function applyLocalDbUpdate(
  accountId: string,
  action: EmailAction,
): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "markRead":
      await db.execute(
        "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
        [action.read ? 1 : 0, accountId, action.threadId],
      );
      break;
    case "star":
      await db.execute(
        "UPDATE threads SET is_starred = $1 WHERE account_id = $2 AND id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      if (action.starred) {
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'STARRED')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'",
          [accountId, action.threadId],
        );
      }
      break;
    case "archive":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      break;
    case "trash":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id IN ('INBOX', 'SPAM')",
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, action.threadId],
      );
      break;
    case "permanentDelete":
      await db.execute(
        "DELETE FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      break;
    case "spam":
      if (action.isSpam) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SPAM')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
          [accountId, action.threadId],
        );
      }
      break;
    case "addLabel":
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, action.labelId],
      );
      break;
    case "removeLabel":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, action.labelId],
      );
      break;
    default:
      break;
  }
  void updateBadgeCount();
}

/**
 * Puts the local copy back after a permanent failure, so the thread is where Gmail still has it
 * (an archive that did not happen leaves it in the inbox; a star that did not happen, unstarred).
 */
async function revertLocalDbUpdate(accountId: string, action: EmailAction): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "archive":
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
        [accountId, action.threadId],
      );
      void updateBadgeCount();
      break;
    case "star":
      await applyLocalDbUpdate(accountId, { ...action, starred: !action.starred });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function getResourceId(action: EmailAction): string {
  if ("threadId" in action && action.threadId) return action.threadId;
  return crypto.randomUUID();
}

function actionToParams(action: EmailAction): Record<string, unknown> {
  // Strip the type field: it's stored separately as operation_type
  const { type: _, ...rest } = action;
  return rest;
}

async function executeViaProvider(
  accountId: string,
  action: EmailAction,
): Promise<unknown> {
  const provider = await getEmailProvider(accountId);
  switch (action.type) {
    case "archive":
      return provider.archive(action.threadId, action.messageIds);
    case "trash":
      return provider.trash(action.threadId, action.messageIds);
    case "permanentDelete":
      return provider.permanentDelete(action.threadId, action.messageIds);
    case "markRead":
      return provider.markRead(
        action.threadId,
        action.messageIds,
        action.read,
      );
    case "star":
      return provider.star(
        action.threadId,
        action.messageIds,
        action.starred,
      );
    case "spam":
      return provider.spam(
        action.threadId,
        action.messageIds,
        action.isSpam,
      );
    case "moveToFolder":
      return provider.moveToFolder(
        action.threadId,
        action.messageIds,
        action.folderPath,
      );
    case "addLabel":
      return provider.addLabel(action.threadId, action.labelId);
    case "removeLabel":
      return provider.removeLabel(action.threadId, action.labelId);
    case "sendMessage":
      return provider.sendMessage(action.rawBase64Url, action.threadId);
  }
}

type Started = {
  accountId: string;
  action: EmailAction;
  /** Set while Gmail has not confirmed the change. Sync will not overwrite this thread. */
  opId: string | null;
  queued: boolean;
  /** Labels from before a trash, so a permanent failure can put them back. */
  labels: string[];
};

async function readLabels(accountId: string, threadId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  return rows.map((row) => row.label_id);
}

async function restoreLabels(accountId: string, threadId: string, labels: readonly string[]): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2", [accountId, threadId]);
  for (const labelId of labels) {
    await db.execute(
      "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
      [accountId, threadId, labelId],
    );
  }
}

/** Labels a thread had before its last trash in this session, so Undo knows whether it came from the inbox. */
const trashedFrom = new Map<string, readonly string[]>();

/** Whether the thread was in the inbox when it was last trashed. False when it was not trashed in this session. */
export function wasInInboxBeforeTrash(accountId: string, threadId: string): boolean {
  return trashedFrom.get(`${accountId}:${threadId}`)?.includes("INBOX") ?? false;
}

/** Writes the local change and records it before any network call. */
async function begin(accountId: string, action: EmailAction): Promise<Started> {
  const labels = action.type === "trash" ? await readLabels(accountId, action.threadId) : [];
  if (action.type === "trash") trashedFrom.set(`${accountId}:${action.threadId}`, labels);
  try {
    await applyLocalDbUpdate(accountId, action);
  } catch (err) {
    console.warn("Local DB update failed:", err);
  }

  const params = actionToParams(action);
  if (!useUIStore.getState().isOnline) {
    await enqueuePendingOperation(accountId, action.type, getResourceId(action), params);
    return { accountId, action, opId: null, queued: true, labels };
  }

  const opId = await enqueuePendingOperation(accountId, action.type, getResourceId(action), params, "executing");
  return { accountId, action, opId, queued: false, labels };
}

/** Sends one change that `begin` already stored. A retryable failure stays in the queue. */
async function finish(started: Started): Promise<ActionResult> {
  if (started.queued || !started.opId) return { success: true, queued: true };
  try {
    const data = await executeViaProvider(started.accountId, started.action);
    await deleteOperation(started.opId);
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);
    if (retriesSafely(started.action.type, classified)) {
      await updateOperationStatus(started.opId, "pending", classified.message);
      return { success: true, queued: true };
    }
    if (classified.isRetryable) {
      // A send that may have gone. The caller still holds the message and says so; nothing sends it again.
      await deleteOperation(started.opId);
      console.error("Send of unknown outcome, not retried:", err);
      return { success: false, uncertain: true, error: classified.message };
    }

    await deleteOperation(started.opId);
    if (started.action.type === "trash") {
      await restoreLabels(started.accountId, started.action.threadId, started.labels).catch((e) =>
        console.warn("Local DB revert failed:", e),
      );
    } else {
      await revertLocalDbUpdate(started.accountId, started.action).catch((e) =>
        console.warn("Local DB revert failed:", e),
      );
    }
    console.error(`Email action ${started.action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

export async function executeEmailAction(
  accountId: string,
  action: EmailAction,
): Promise<ActionResult> {
  return finish(await begin(accountId, action));
}

/**
 * Archive a batch. Every thread leaves the local inbox, and is marked in flight, before the first
 * Gmail call. A sync that still sees INBOX cannot put them back.
 */
export async function archiveThreads(
  items: readonly { accountId: string; threadId: string; messageIds: string[] }[],
): Promise<ActionResult> {
  if (items.length === 0) return { success: true };
  const started: Started[] = [];
  for (const item of items) {
    started.push(
      await begin(item.accountId, { type: "archive", threadId: item.threadId, messageIds: item.messageIds }),
    );
  }
  let failed = 0;
  for (const item of started) {
    if (!(await finish(item)).success) failed += 1;
  }
  if (failed === started.length) return { success: false, error: "Couldn't archive" };
  return { success: true };
}

export async function trashThreads(
  items: readonly { accountId: string; threadId: string; messageIds: string[] }[],
): Promise<ActionResult> {
  if (items.length === 0) return { success: true };
  const started: Started[] = [];
  for (const item of items) {
    started.push(
      await begin(item.accountId, { type: "trash", threadId: item.threadId, messageIds: item.messageIds }),
    );
  }
  let failed = 0;
  for (const item of started) {
    if (!(await finish(item)).success) failed += 1;
  }
  if (failed === started.length) return { success: false, error: "Couldn't delete" };
  return { success: true };
}

// ---------------------------------------------------------------------------
// Execute a queued operation (used by queue processor)
// ---------------------------------------------------------------------------

export async function executeQueuedAction(
  accountId: string,
  operationType: string,
  params: Record<string, unknown>,
): Promise<void> {
  const action = { type: operationType, ...params } as EmailAction;
  await executeViaProvider(accountId, action);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function archiveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "archive",
    threadId,
    messageIds,
  });
}

/**
 * Undoes an archive. An archive still waiting in the offline queue is dropped (so it can never
 * run after the undo); otherwise the thread gets INBOX back through the provider.
 */
export async function unarchiveThread(
  accountId: string,
  threadId: string,
): Promise<ActionResult> {
  const dropped = await deletePendingOperations(accountId, threadId, "archive");
  if (dropped > 0) {
    await applyLocalDbUpdate(accountId, { type: "addLabel", threadId, labelId: "INBOX" });
    return { success: true };
  }
  return addThreadLabel(accountId, threadId, "INBOX");
}

/**
 * Undoes a delete. A trash still waiting in the queue is dropped first (so it can never run after the undo) and the
 * thread gets back the labels it had locally; otherwise the provider takes TRASH off and puts `back` on.
 */
export async function untrashThread(
  accountId: string,
  threadId: string,
  back: "INBOX" | "SPAM" | null,
): Promise<ActionResult> {
  const dropped = await deletePendingOperations(accountId, threadId, "trash");
  if (dropped > 0) {
    const before = trashedFrom.get(`${accountId}:${threadId}`);
    if (before) {
      await restoreLabels(accountId, threadId, before);
    } else {
      await applyLocalDbUpdate(accountId, { type: "removeLabel", threadId, labelId: "TRASH" });
      if (back) await applyLocalDbUpdate(accountId, { type: "addLabel", threadId, labelId: back });
    }
    void updateBadgeCount();
    return { success: true };
  }
  const removed = await removeThreadLabel(accountId, threadId, "TRASH");
  if (!removed.success || !back) return removed;
  return addThreadLabel(accountId, threadId, back);
}

export function trashThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "trash",
    threadId,
    messageIds,
  });
}

export function permanentDeleteThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "permanentDelete",
    threadId,
    messageIds,
  });
}

export function markThreadRead(
  accountId: string,
  threadId: string,
  messageIds: string[],
  read: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "markRead",
    threadId,
    messageIds,
    read,
  });
}

export function starThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  starred: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "star",
    threadId,
    messageIds,
    starred,
  });
}

export function spamThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  isSpam: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "spam",
    threadId,
    messageIds,
    isSpam,
  });
}

export function moveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  folderPath: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "moveToFolder",
    threadId,
    messageIds,
    folderPath,
  });
}

export function addThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "addLabel",
    threadId,
    labelId,
  });
}

export function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "removeLabel",
    threadId,
    labelId,
  });
}

export async function sendEmail(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
  replyId?: string,
): Promise<ActionResult> {
  const result = await executeEmailAction(accountId, {
    type: "sendMessage",
    rawBase64Url,
    threadId,
    ...(replyId ? { replyId } : {}),
  });

  // Notify the UI to refresh (so sent message appears in Sent folder)
  if (result.success) {
    window.dispatchEvent(new Event("voa-sync-done"));
  }

  return result;
}

