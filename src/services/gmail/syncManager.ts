import { getGmailClient } from "./tokenManager";
import { initialSync, deltaSync, continueBackfill, catchUpSpam, catchUpSent, type SyncProgress } from "./sync";
import { GmailRateLimitError } from "./quota";
import { getAccount, clearAccountHistoryId } from "../db/accounts";
import { getSetting } from "../db/settings";
import { getThreadCountForAccount } from "../db/threads";
import { imapInitialSync, imapDeltaSync } from "../imap/imapSync";
import { syncGraphAccount } from "../graph/sync";
import { GraphThrottledError } from "../graph/client";
import { clearAllFolderSyncStates } from "../db/folderSyncState";
import { ensureFreshToken } from "../oauth/oauthTokenManager";

/** While the window is on screen. A login code should show up in one of these, not a minute later. */
export const SYNC_INTERVAL_VISIBLE_MS = 5_000;
/** Minimized or hidden. An idle history check is one small request, so this only saves the ones nobody is watching. */
export const SYNC_INTERVAL_HIDDEN_MS = 60_000;

/** Map IMAP sync phases to the SyncProgress phases the UI understands. */
function mapImapPhase(phase: string): "labels" | "threads" | "messages" | "done" {
  if (phase === "folders") return "labels";
  if (phase === "threading" || phase === "storing_threads") return "threads";
  if (phase === "messages") return "messages";
  if (phase === "done") return "done";
  return phase as "labels" | "threads" | "messages" | "done";
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncPromise: Promise<void> | null = null;
let pendingAccountIds: string[] | null = null;
let watchedIds: string[] = [];
let watching = false;
let windowVisible = true;

export type SyncStatusCallback = (
  accountId: string,
  status: "syncing" | "done" | "error",
  progress?: SyncProgress,
  error?: string,
) => void;

let statusCallback: SyncStatusCallback | null = null;

export function onSyncStatus(cb: SyncStatusCallback): () => void {
  statusCallback = cb;
  return () => {
    statusCallback = null;
  };
}

async function syncProvider(provider: string, accountId: string): Promise<boolean> {
  if (provider === "imap") return syncImapAccount(accountId);
  if (provider === "graph") return syncGraphAccount(accountId);
  return syncGmailAccount(accountId);
}

/**
 * True when the inbox may have changed (a first sync, or a delta that found mail).
 */
async function syncGmailAccount(accountId: string): Promise<boolean> {
  const client = await getGmailClient(accountId);
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  const syncDays = parseInt(syncPeriodStr ?? "365", 10) || 365;

  if (account.history_id) {
    try {
      const changed = await deltaSync(client, accountId, account.history_id);
      // Accounts that synced before Spam was a list still need one SPAM pass.
      await catchUpSpam(client, accountId).catch((err) =>
        console.error(`Spam catch-up failed for ${accountId}:`, err),
      );
      await catchUpSpam(client, accountId, "TRASH").catch((err) =>
        console.error(`Trash catch-up failed for ${accountId}:`, err),
      );
      await catchUpSent(client, accountId).catch((err) =>
        console.error(`Sent catch-up failed for ${accountId}:`, err),
      );
      // A first sync's backfill cut short (a restart) goes on, in the background.
      void continueBackfill(client, accountId);
      return changed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (message === "HISTORY_EXPIRED") {
        await initialSync(client, accountId, syncDays, (progress) => {
          statusCallback?.(accountId, "syncing", progress);
        });
        return true;
      }
      throw err;
    }
  }
  await initialSync(client, accountId, syncDays, (progress) => {
    statusCallback?.(accountId, "syncing", progress);
  });
  return true;
}

/**
 * True when new messages were stored.
 */
async function syncImapAccount(accountId: string): Promise<boolean> {
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  // Refresh OAuth2 token before syncing (if applicable)
  if (account.auth_method === "oauth2") {
    await ensureFreshToken(account);
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  const syncDays = parseInt(syncPeriodStr ?? "365", 10) || 365;

  if (account.history_id) {
    // Delta sync. IMAP tracks the last UID per folder.
    const result = await imapDeltaSync(accountId, syncDays);

    // Recovery: if delta sync found nothing new but the DB has no threads,
    // the previous initial sync likely failed or stored data incorrectly.
    // Force a full re-sync to recover.
    if (result.messages.length === 0) {
      const threadCount = await getThreadCountForAccount(accountId);
      if (threadCount === 0) {
        console.warn(`[syncManager] IMAP delta sync returned 0 new messages and DB has 0 threads for ${accountId}, forcing a full re-sync`);
        await clearAccountHistoryId(accountId);
        await clearAllFolderSyncStates(accountId);
        await imapInitialSync(accountId, syncDays, (progress) => {
          statusCallback?.(accountId, "syncing", {
            phase: mapImapPhase(progress.phase),
            current: progress.current,
            total: progress.total,
          });
        });
        return true;
      }
      return false;
    }
    return true;
  }
  await imapInitialSync(accountId, syncDays, (progress) => {
    statusCallback?.(accountId, "syncing", {
      phase: mapImapPhase(progress.phase),
      current: progress.current,
      total: progress.total,
    });
  });
  return true;
}

/**
 * Run a sync for a single account (initial or delta).
 * Gmail, IMAP and Outlook each have their own sync. The cursor for all three is history_id.
 */
async function syncAccountInternal(accountId: string): Promise<void> {
  try {
    const account = await getAccount(accountId);

    if (!account) {
      throw new Error("Account not found");
    }

    const first = account.history_id == null && account.provider !== "caldav";
    // A routine check stays quiet. "Syncing" is for the first download, which actually takes time.
    if (first) statusCallback?.(accountId, "syncing");

    if (account.provider === "caldav") {
      // A calendar-only account left over from Velo: nothing to sync.
      statusCallback?.(accountId, "done");
      return;
    }

    const changed = await syncProvider(account.provider, accountId);
    if (changed) console.log(`[syncManager] Mail changed for ${accountId}`);

    // A sync that ended without a history id never completed: say so, or the inbox waits on
    // "Syncing…" forever instead of offering Reconnect. An Outlook full pass that stopped at its page limit
    // goes on at the next interval: still syncing, and what it stored so far is shown.
    const after = await getAccount(accountId);
    if (!after?.history_id) {
      if (after?.provider === "graph" && after.graph_next_link) {
        statusCallback?.(accountId, "syncing", { phase: "done", current: 0, total: 0 });
        return;
      }
      throw new Error("The first sync did not finish");
    }

    // "done" reloads the list. An idle check must not, or the inbox redraws every few seconds.
    if (first || changed) statusCallback?.(accountId, "done");
  } catch (err) {
    if (err instanceof GmailRateLimitError || err instanceof GraphThrottledError) {
      // The provider's quota or load, not the account: nothing to reconnect. The next interval tries again; until
      // then a synced account stays as it was and one still in its first sync keeps syncing.
      console.warn(`[syncManager] The provider held account ${accountId}'s sync, tried again at the next one:`, err.message);
      const synced = Boolean((await getAccount(accountId).catch(() => null))?.history_id);
      statusCallback?.(accountId, synced ? "done" : "syncing");
      return;
    }
    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    console.error(`[syncManager] Sync failed for account ${accountId}:`, message);
    statusCallback?.(accountId, "error", undefined, message);
  }
}

async function runSync(accountIds: string[]): Promise<void> {
  if (syncPromise) {
    // Queue these accounts, merging with any already-pending IDs
    const existing = new Set(pendingAccountIds ?? []);
    for (const id of accountIds) existing.add(id);
    pendingAccountIds = [...existing];
    return syncPromise;
  }

  syncPromise = (async () => {
    try {
      for (const id of accountIds) {
        await syncAccountInternal(id);
      }
    } finally {
      syncPromise = null;
    }

    // Drain the queue: if something was queued while we were syncing, run it now
    if (pendingAccountIds) {
      const queued = pendingAccountIds;
      pendingAccountIds = null;
      await runSync(queued);
    }
  })();

  return syncPromise;
}

/**
 * Run sync for a single account, queuing if already running.
 */
export async function syncAccount(accountId: string): Promise<void> {
  return runSync([accountId]);
}

/**
 * Start the background sync timer for all accounts.
 * When `skipImmediateSync` is true the first periodic sync is deferred to the
 * next interval tick: useful when the caller already triggered a sync for a
 * newly-added account and doesn't want existing accounts to block it.
 */
function reschedule(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  if (!watching) return;
  syncTimer = setInterval(() => {
    void runSync(watchedIds);
  }, windowVisible ? SYNC_INTERVAL_VISIBLE_MS : SYNC_INTERVAL_HIDDEN_MS);
}

/**
 * The window is on screen, or it was minimized or hidden.
 * Coming back asks at once, so a code that arrived while the app was away is already there.
 */
export function setSyncWindowVisible(visible: boolean): void {
  const cameBack = visible && !windowVisible;
  windowVisible = visible;
  if (!watching) return;
  reschedule();
  if (cameBack) void runSync(watchedIds);
}

export function startBackgroundSync(accountIds: string[], skipImmediateSync = false): void {
  stopBackgroundSync();
  watchedIds = accountIds;
  watching = true;

  if (!skipImmediateSync) {
    void runSync(accountIds);
  }

  reschedule();
}

/**
 * Stop the background sync timer.
 */
export function stopBackgroundSync(): void {
  watching = false;
  watchedIds = [];
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Trigger an immediate sync for all provided accounts.
 * Waits for completion even if a background sync is in progress.
 */
export async function triggerSync(accountIds: string[]): Promise<void> {
  await runSync(accountIds);
}

