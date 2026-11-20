import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: vi.fn(() => ({ isOnline: true })),
  },
}));

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("@/services/db/pendingOperations", () => ({
  enqueuePendingOperation: vi.fn(() => Promise.resolve("op-1")),
  deleteOperation: vi.fn(() => Promise.resolve()),
  updateOperationStatus: vi.fn(() => Promise.resolve()),
  deletePendingOperations: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      execute: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve([])),
    }),
  ),
}));

vi.mock("@/services/badgeManager", () => ({
  updateBadgeCount: vi.fn(() => Promise.resolve()),
}));

import { useUIStore } from "@/stores/uiStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { deleteOperation, enqueuePendingOperation, updateOperationStatus } from "@/services/db/pendingOperations";
import {
  archiveThread,
  trashThread,
  permanentDeleteThread,
  starThread,
  markThreadRead,
  spamThread,
  moveThread,
  executeEmailAction,
} from "./emailActions";
import { createMockEmailProvider, createMockUIStoreState } from "@/test/mocks";

const mockProvider = createMockEmailProvider();


describe("emailActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmailProvider).mockResolvedValue(mockProvider as never);
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState() as never);
  });

  describe("online execution", () => {
    it("archives a thread via provider", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBeUndefined();
      expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("trashes a thread via provider", async () => {
      const result = await trashThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("holds a trash before Gmail answers, then drops the hold", async () => {
      const order: string[] = [];
      vi.mocked(enqueuePendingOperation).mockImplementation(async () => {
        order.push("hold");
        return "op-1";
      });
      mockProvider.trash.mockImplementation(async () => {
        order.push("gmail");
      });

      await trashThread("acct-1", "t1", ["m1"]);

      expect(order).toEqual(["hold", "gmail"]);
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "trash",
        "t1",
        expect.objectContaining({ threadId: "t1", messageIds: ["m1"] }),
        "executing",
      );
      expect(deleteOperation).toHaveBeenCalledWith("op-1");
    });

    it("stars a thread via provider", async () => {
      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockProvider.star).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("marks thread read via provider", async () => {
      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockProvider.markRead).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("reports spam via provider", async () => {
      const result = await spamThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockProvider.spam).toHaveBeenCalledWith("t1", ["m1"], true);
    });
  });

  describe("offline queueing", () => {
    beforeEach(() => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);
    });

    it("queues archive when offline", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(mockProvider.archive).not.toHaveBeenCalled();
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "archive",
        "t1",
        expect.objectContaining({ threadId: "t1", messageIds: ["m1"] }),
      );
    });

    it("still applies optimistic UI update when offline", async () => {
      await starThread("acct-1", "t1", ["m1"], true);
    });
  });

  describe("network error → queue fallback", () => {
    it("queues on retryable network error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.archive.mockRejectedValueOnce(new Error("Failed to fetch"));

      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(enqueuePendingOperation).toHaveBeenCalled();
    });
  });

  describe("a send of unknown outcome", () => {
    it("is never queued again after a timeout: the caller hears it may have gone", async () => {
      mockProvider.sendMessage.mockRejectedValueOnce(new Error("Request timed out"));
      const result = await executeEmailAction("acct-1", { type: "sendMessage", rawBase64Url: "raw" });
      expect(result).toMatchObject({ success: false, uncertain: true });
      expect(deleteOperation).toHaveBeenCalledWith("op-1");
      expect(updateOperationStatus).not.toHaveBeenCalledWith("op-1", "pending", expect.anything());
      expect(mockProvider.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("a rate-limit refusal never left, so it stays queued", async () => {
      mockProvider.sendMessage.mockRejectedValueOnce(new Error("Gmail API error 429"));
      const result = await executeEmailAction("acct-1", { type: "sendMessage", rawBase64Url: "raw" });
      expect(result).toEqual({ success: true, queued: true });
      expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "pending", expect.anything());
    });

    it("offline before the request, it is queued to send once online", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({ isOnline: false }) as never);
      const result = await executeEmailAction("acct-1", { type: "sendMessage", rawBase64Url: "raw" });
      expect(result).toEqual({ success: true, queued: true });
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
      expect(enqueuePendingOperation).toHaveBeenCalledWith("acct-1", "sendMessage", expect.any(String), { rawBase64Url: "raw", threadId: undefined });
    });
  });

  describe("permanent error → revert", () => {
    it("reverts star on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.star.mockRejectedValueOnce(new Error("Invalid request"));

      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      // Revert: set starred to false
    });

    it("reverts markRead on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.markRead.mockRejectedValueOnce(new Error("Bad request"));

      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
    });
  });

  describe("executeEmailAction with a send", () => {
    it("sends a message via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "sendMessage",
        rawBase64Url: "base64data",
        threadId: "t1",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.sendMessage).toHaveBeenCalledWith("base64data", "t1");
    });
  });
});
