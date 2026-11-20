import { createBackgroundChecker, type BackgroundChecker } from "../backgroundCheckers";
import { useUIStore } from "@/stores/uiStore";
import {
  getPendingOperations,
  updateOperationStatus,
  deleteOperation,
  incrementRetry,
  compactQueue,
  recoverInterruptedOperations,
} from "../db/pendingOperations";
import { executeQueuedAction } from "../emailActions";
import { classifyError, retriesSafely } from "@/utils/networkErrors";
import { surfaceUnsentMessages } from "@/voa/compose/unsentMessages";

const BATCH_SIZE = 50;

let checker: BackgroundChecker | null = null;

/** When this run started. Operations older than it and still `executing` were cut short by a quit. */
const startedAt = Math.floor(Date.now() / 1000);
let recovered = false;

/** The pass in flight. A second caller (the online event while the timer runs) waits for it and asks for one more. */
let running: Promise<void> | null = null;
let again = false;

function processQueue(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await processOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function processOnce(): Promise<void> {
  if (!recovered) {
    await recoverInterruptedOperations(startedAt);
    recovered = true;
    // A send the last run left unsure (or failed) is shown now, never sent again.
    void surfaceUnsentMessages().catch((err) => console.error("[QueueProcessor] could not show unsent mail:", err));
  }

  // Skip if offline
  if (!useUIStore.getState().isOnline) return;

  // Compact first to eliminate redundant ops
  await compactQueue();

  // Get pending operations
  const ops = await getPendingOperations(undefined, BATCH_SIZE);
  if (ops.length === 0) return;

  for (const op of ops) {
    try {
      // Mark as executing
      await updateOperationStatus(op.id, "executing");

      // Parse params and execute
      const params = JSON.parse(op.params) as Record<string, unknown>;
      await executeQueuedAction(op.account_id, op.operation_type, params);

      // Success: delete from queue
      await deleteOperation(op.id);
    } catch (err) {
      const classified = classifyError(err);

      if (retriesSafely(op.operation_type, classified)) {
        // Increment retry with exponential backoff
        await updateOperationStatus(op.id, "pending", classified.message);
        await incrementRetry(op.id);
      } else {
        // Refused for good (`failed`), or a send that may have gone (`uncertain`): neither runs again by itself.
        const uncertain = op.operation_type === "sendMessage" && classified.isRetryable;
        await updateOperationStatus(op.id, uncertain ? "uncertain" : "failed", classified.message);
      }
    }
  }

  // A send that failed here (refused, or of unknown outcome) is shown, never sent again.
  if (ops.some((op) => op.operation_type === "sendMessage")) {
    void surfaceUnsentMessages().catch((err) => console.error("[QueueProcessor] could not show unsent mail:", err));
  }
}

export function startQueueProcessor(): void {
  if (checker) return;
  checker = createBackgroundChecker("QueueProcessor", processQueue, 30_000);
  checker.start();
}

export function stopQueueProcessor(): void {
  checker?.stop();
  checker = null;
}

/**
 * Trigger an immediate queue flush (e.g., when coming back online).
 * Returns a promise that resolves when processing completes.
 */
export async function triggerQueueFlush(): Promise<void> {
  try {
    await processQueue();
  } catch (err) {
    console.error("[QueueProcessor] flush failed:", err);
  }
}
