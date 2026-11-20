import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: vi.fn(() => ({ isOnline: true })),
  },
}));

vi.mock("../db/pendingOperations", () => ({
  getPendingOperations: vi.fn(() => Promise.resolve([])),
  updateOperationStatus: vi.fn(() => Promise.resolve()),
  deleteOperation: vi.fn(() => Promise.resolve()),
  incrementRetry: vi.fn(() => Promise.resolve()),
  compactQueue: vi.fn(() => Promise.resolve(0)),
  recoverInterruptedOperations: vi.fn(() => Promise.resolve()),
}));

vi.mock("../emailActions", () => ({
  executeQueuedAction: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/networkErrors", async (importOriginal) => ({
  retriesSafely: (await importOriginal<typeof import("@/utils/networkErrors")>()).retriesSafely,
  classifyError: vi.fn(() => ({
    type: "permanent",
    isRetryable: false,
    message: "error",
  })),
}));

vi.mock("@/voa/compose/unsentMessages", () => ({
  surfaceUnsentMessages: vi.fn(() => Promise.resolve()),
}));

vi.mock("../backgroundCheckers", () => ({
  createBackgroundChecker: vi.fn((_name: string, fn: () => Promise<void>) => ({
    start: () => fn(),
    stop: vi.fn(),
  })),
}));

import { useUIStore } from "@/stores/uiStore";
import {
  getPendingOperations,
  updateOperationStatus,
  deleteOperation,
  incrementRetry,
  compactQueue,
} from "../db/pendingOperations";
import { executeQueuedAction } from "../emailActions";
import { classifyError } from "@/utils/networkErrors";
import { startQueueProcessor, stopQueueProcessor, triggerQueueFlush } from "./queueProcessor";
import { createMockUIStoreState } from "@/test/mocks";


describe("queueProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({
    }) as never);
    vi.mocked(getPendingOperations).mockResolvedValue([]);
  });

  it("puts back what a run that quit left executing, once, before anything else, even offline", async () => {
    vi.resetModules();
    const fresh = await import("./queueProcessor");
    const db = await import("../db/pendingOperations");
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({
      isOnline: false,
    }) as never);
    await fresh.triggerQueueFlush();
    await fresh.triggerQueueFlush();
    expect(db.recoverInterruptedOperations).toHaveBeenCalledTimes(1);
    const unsent = await import("@/voa/compose/unsentMessages");
    expect(unsent.surfaceUnsentMessages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(unsent.surfaceUnsentMessages).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(db.recoverInterruptedOperations).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(db.recoverInterruptedOperations).mock.calls[0]?.[0]).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("never runs two passes at once: a flush during a pass waits for it, then reads the queue again", async () => {
    let release!: () => void;
    vi.mocked(executeQueuedAction).mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    vi.mocked(getPendingOperations).mockResolvedValueOnce([
      {
        id: "op-1",
        account_id: "acct-1",
        operation_type: "archive",
        resource_id: "t1",
        params: '{"threadId":"t1","messageIds":[]}',
        status: "pending",
        retry_count: 0,
        max_retries: 10,
        next_retry_at: null,
        created_at: 1000,
        error_message: null,
      },
    ]);

    const first = triggerQueueFlush();
    await vi.waitFor(() => expect(executeQueuedAction).toHaveBeenCalledTimes(1));
    const second = triggerQueueFlush();
    await Promise.resolve();
    expect(getPendingOperations).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(executeQueuedAction).toHaveBeenCalledTimes(1);
    expect(getPendingOperations).toHaveBeenCalledTimes(2);
  });

  it("skips processing when offline", async () => {
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({
      isOnline: false,
    }) as never);
    await triggerQueueFlush();
    expect(getPendingOperations).not.toHaveBeenCalled();
  });

  it("compacts queue before processing", async () => {
    await triggerQueueFlush();
    expect(compactQueue).toHaveBeenCalled();
  });

  it("processes pending operations successfully", async () => {
    vi.mocked(getPendingOperations).mockResolvedValueOnce([
      {
        id: "op-1",
        account_id: "acct-1",
        operation_type: "archive",
        resource_id: "t1",
        params: '{"threadId":"t1","messageIds":[]}',
        status: "pending",
        retry_count: 0,
        max_retries: 10,
        next_retry_at: null,
        created_at: 1000,
        error_message: null,
      },
    ]);

    await triggerQueueFlush();

    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "executing");
    expect(executeQueuedAction).toHaveBeenCalledWith("acct-1", "archive", {
      threadId: "t1",
      messageIds: [],
    });
    expect(deleteOperation).toHaveBeenCalledWith("op-1");
  });

  it("retries on retryable errors", async () => {
    vi.mocked(getPendingOperations).mockResolvedValueOnce([
      {
        id: "op-1",
        account_id: "acct-1",
        operation_type: "star",
        resource_id: "t1",
        params: '{"threadId":"t1","messageIds":[],"starred":true}',
        status: "pending",
        retry_count: 0,
        max_retries: 10,
        next_retry_at: null,
        created_at: 1000,
        error_message: null,
      },
    ]);
    vi.mocked(executeQueuedAction).mockRejectedValueOnce(new Error("Failed to fetch"));
    vi.mocked(classifyError).mockReturnValueOnce({
      type: "network",
      isRetryable: true,
      message: "Failed to fetch",
    });

    await triggerQueueFlush();

    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "pending", "Failed to fetch");
    expect(incrementRetry).toHaveBeenCalledWith("op-1");
    expect(deleteOperation).not.toHaveBeenCalled();
  });

  it("a queued send that times out is marked failed, never retried, and shown", async () => {
    vi.mocked(getPendingOperations).mockResolvedValueOnce([
      {
        id: "op-1",
        account_id: "acct-1",
        operation_type: "sendMessage",
        resource_id: "x",
        params: '{"rawBase64Url":"raw"}',
        status: "pending",
        retry_count: 0,
        max_retries: 10,
        next_retry_at: null,
        created_at: 1000,
        error_message: null,
      },
    ]);
    vi.mocked(executeQueuedAction).mockRejectedValueOnce(new Error("timed out"));
    vi.mocked(classifyError).mockReturnValueOnce({ type: "network", isRetryable: true, message: "timed out" });
    const unsent = await import("@/voa/compose/unsentMessages");
    vi.mocked(unsent.surfaceUnsentMessages).mockClear();

    await triggerQueueFlush();

    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "uncertain", "timed out");
    expect(incrementRetry).not.toHaveBeenCalled();
    expect(unsent.surfaceUnsentMessages).toHaveBeenCalled();
  });

  it("marks as failed on permanent errors", async () => {
    vi.mocked(getPendingOperations).mockResolvedValueOnce([
      {
        id: "op-1",
        account_id: "acct-1",
        operation_type: "archive",
        resource_id: "t1",
        params: '{"threadId":"t1","messageIds":[]}',
        status: "pending",
        retry_count: 0,
        max_retries: 10,
        next_retry_at: null,
        created_at: 1000,
        error_message: null,
      },
    ]);
    vi.mocked(executeQueuedAction).mockRejectedValueOnce(new Error("Bad request"));
    vi.mocked(classifyError).mockReturnValueOnce({
      type: "permanent",
      isRetryable: false,
      message: "Bad request",
    });

    await triggerQueueFlush();

    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "failed", "Bad request");
  });

  it("start and stop work without errors", () => {
    startQueueProcessor();
    stopQueueProcessor();
  });
});
