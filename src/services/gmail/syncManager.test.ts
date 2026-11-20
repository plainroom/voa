import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all dependencies before importing the module under test
vi.mock("./tokenManager", () => ({
  getGmailClient: vi.fn(),
}));
vi.mock("./sync", () => ({
  initialSync: vi.fn(),
  deltaSync: vi.fn(),
  continueBackfill: vi.fn(async () => {}),
  catchUpSpam: vi.fn(async () => {}),
  catchUpSent: vi.fn(async () => {}),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  clearAccountHistoryId: vi.fn(),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("365"),
}));
vi.mock("../db/threads", () => ({
  getThreadCountForAccount: vi.fn(),
  deleteAllThreadsForAccount: vi.fn(),
}));
vi.mock("../db/messages", () => ({
  deleteAllMessagesForAccount: vi.fn(),
}));
vi.mock("../imap/imapSync", () => ({
  imapInitialSync: vi.fn(),
  imapDeltaSync: vi.fn(),
}));
vi.mock("../db/folderSyncState", () => ({
  clearAllFolderSyncStates: vi.fn(),
}));
vi.mock("../graph/sync", () => ({
  syncGraphAccount: vi.fn(),
}));
vi.mock("../oauth/oauthTokenManager", () => ({
  ensureFreshToken: vi.fn(),
}));
vi.mock("../calendar/providerFactory", () => ({
  hasCalendarSupport: vi.fn().mockResolvedValue(false),
  getCalendarProvider: vi.fn(),
}));
vi.mock("../db/calendars", () => ({
  getVisibleCalendars: vi.fn().mockResolvedValue([]),
  upsertCalendar: vi.fn(),
  updateCalendarSyncToken: vi.fn(),
}));
vi.mock("../db/calendarEvents", () => ({
  upsertCalendarEvent: vi.fn(),
  deleteEventByRemoteId: vi.fn(),
}));

// Import after mocks
import {
  syncAccount,
  startBackgroundSync,
  stopBackgroundSync,
  setSyncWindowVisible,
  SYNC_INTERVAL_HIDDEN_MS,
  SYNC_INTERVAL_VISIBLE_MS,
  triggerSync,
  onSyncStatus,
} from "./syncManager";
import { getAccount } from "../db/accounts";
import { getGmailClient } from "./tokenManager";
import { initialSync, deltaSync, continueBackfill } from "./sync";
import { GmailRateLimitError } from "./quota";
import { syncGraphAccount } from "../graph/sync";
import { GraphThrottledError } from "../graph/client";

const mockGetAccount = vi.mocked(getAccount);
const mockGetGmailClient = vi.mocked(getGmailClient);
const mockInitialSync = vi.mocked(initialSync);
const mockDeltaSync = vi.mocked(deltaSync);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeGmailAccount(id: string, historyId: string | null = null) {
  return {
    id,
    email: `${id}@gmail.com`,
    display_name: id,
    avatar_url: null,
    is_active: 1,
    provider: "gmail_api" as const,
    history_id: historyId,
    refresh_token: "tok",
    access_token: "tok",
    token_expiry: Date.now() + 60_000,
    client_id: "cid",
    client_secret: null,
    created_at: new Date().toISOString(),
    imap_host: null,
    imap_port: null,
    imap_security: null,
    smtp_host: null,
    smtp_port: null,
    smtp_security: null,
    auth_method: null,
    imap_password: null,
    imap_username: null,
  };
}

describe("syncManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopBackgroundSync();
    mockGetGmailClient.mockResolvedValue(
      {} as ReturnType<typeof getGmailClient> extends Promise<infer T>
        ? T
        : never,
    );
    mockInitialSync.mockResolvedValue();
    mockDeltaSync.mockResolvedValue();
  });

  afterEach(() => {
    stopBackgroundSync();
    setSyncWindowVisible(true);
  });

  describe("syncAccount", () => {
    it("runs initial sync for an account without history_id", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1"));

      await syncAccount("a1");

      expect(mockInitialSync).toHaveBeenCalledTimes(1);
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("a first sync that ends without a history id reports an error, so Reconnect shows", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1"));
      const statuses: string[] = [];
      const off = onSyncStatus((_id, status) => void statuses.push(status));

      await syncAccount("a1");
      off();

      expect(statuses).toEqual(["syncing", "error"]);
    });

    it("a first sync that stores a history id is done", async () => {
      mockGetAccount.mockResolvedValueOnce(makeGmailAccount("a1")).mockResolvedValueOnce(makeGmailAccount("a1")).mockResolvedValue(makeGmailAccount("a1", "500"));
      const statuses: string[] = [];
      const off = onSyncStatus((_id, status) => void statuses.push(status));

      await syncAccount("a1");
      off();

      expect(statuses).toEqual(["syncing", "done"]);
    });

    it("runs delta sync for an account with history_id", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "12345"));

      await syncAccount("a1");

      expect(mockDeltaSync).toHaveBeenCalledTimes(1);
      expect(mockInitialSync).not.toHaveBeenCalled();
      // A first sync's backfill a restart cut short goes on after it.
      expect(vi.mocked(continueBackfill)).toHaveBeenCalledWith(expect.anything(), "a1");
    });

    it("an idle delta does not announce itself, and one that found mail asks the list to reload", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "12345"));
      const statuses: string[] = [];
      const off = onSyncStatus((_id, status) => void statuses.push(status));

      mockDeltaSync.mockResolvedValue(false);
      await syncAccount("a1");
      expect(statuses).toEqual([]);

      mockDeltaSync.mockResolvedValue(true);
      await syncAccount("a1");
      off();
      expect(statuses).toEqual(["done"]);
    });

    it("queues a second account while sync is in progress", async () => {
      const a1 = makeGmailAccount("a1", "100");
      const a2 = makeGmailAccount("a2", "200");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        return null;
      });

      // Make first sync slow
      const barrier = new Promise<void>((r) => {
        // Resolve after 50ms
        setTimeout(r, 50);
      });
      let firstCall = true;
      mockDeltaSync.mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return barrier;
        }
        return Promise.resolve();
      });

      const first = syncAccount("a1");
      // a2 will be queued since a1 is in progress
      const second = syncAccount("a2");

      await first;
      await second;

      // Both accounts synced (a1 directly, a2 via queue drain)
      expect(mockDeltaSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("startBackgroundSync", () => {
    it("triggers an immediate sync by default", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));

      startBackgroundSync(["a1"]);

      // Wait for async sync chain to complete
      await wait(50);

      expect(mockDeltaSync).toHaveBeenCalledTimes(1);
    });

    it("skips immediate sync when skipImmediateSync is true", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));

      startBackgroundSync(["a1"], true);

      // Wait. Nothing should have fired (the next check is seconds away).
      await wait(50);

      expect(mockDeltaSync).not.toHaveBeenCalled();
      expect(mockGetAccount).not.toHaveBeenCalled();
    });

    it("asks every few seconds while the window is visible, and once a minute when it is hidden", async () => {
      vi.useFakeTimers();
      try {
        mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));
        mockDeltaSync.mockResolvedValue(false);
        startBackgroundSync(["a1"], true);

        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_VISIBLE_MS - 1);
        expect(mockDeltaSync).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(mockDeltaSync).toHaveBeenCalledTimes(1);

        setSyncWindowVisible(false);
        mockDeltaSync.mockClear();
        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_VISIBLE_MS);
        expect(mockDeltaSync).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_HIDDEN_MS - SYNC_INTERVAL_VISIBLE_MS);
        expect(mockDeltaSync).toHaveBeenCalledTimes(1);

        mockDeltaSync.mockClear();
        setSyncWindowVisible(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(mockDeltaSync).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("new account sync priority", () => {
    it("new account syncs immediately when background sync skips immediate run", async () => {
      const existingAccount = makeGmailAccount("existing", "100");
      const newAccount = makeGmailAccount("new-acc");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "existing") return existingAccount;
        if (id === "new-acc") return newAccount;
        return null;
      });

      // Simulate the fix: sync new account first, then start background with skipImmediate
      const syncPromise = syncAccount("new-acc");
      startBackgroundSync(["existing", "new-acc"], true);

      await syncPromise;

      // The new account got an initial sync immediately
      expect(mockInitialSync).toHaveBeenCalledTimes(1);
      // No delta sync ran (background timer hasn't fired)
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("without the fix, new account sync would be blocked by existing account sync", async () => {
      const existingAccount = makeGmailAccount("existing", "100");
      const newAccount = makeGmailAccount("new-acc");

      // Track the order of sync calls
      const syncOrder: string[] = [];

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "existing") return existingAccount;
        if (id === "new-acc") return newAccount;
        return null;
      });

      mockDeltaSync.mockImplementation(async () => {
        syncOrder.push("delta-existing");
      });
      mockInitialSync.mockImplementation(async () => {
        syncOrder.push("initial-new");
      });

      // Old behavior: startBackgroundSync first (with immediate sync), then syncAccount
      // This would queue new-acc behind existing account's delta sync
      startBackgroundSync(["existing", "new-acc"]);

      // Wait for both to complete
      await wait(50);

      // existing account's delta sync ran BEFORE new account's initial sync
      expect(syncOrder).toEqual(["delta-existing", "initial-new"]);
    });
  });

  describe("triggerSync", () => {
    it("syncs all provided accounts", async () => {
      const a1 = makeGmailAccount("a1", "100");
      const a2 = makeGmailAccount("a2", "200");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        return null;
      });

      await triggerSync(["a1", "a2"]);

      expect(mockDeltaSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("error coercion", () => {
    it("propagates plain string errors from Tauri IPC (not 'Unknown error')", async () => {
      const account = makeGmailAccount("a1", "100");
      mockGetAccount.mockResolvedValue(account);
      // Tauri IPC rejects with a plain string, not an Error instance
      mockDeltaSync.mockRejectedValue("authentication failed for user@test.com");

      const errors: string[] = [];
      const unsub = onSyncStatus((_id, status, _progress, error) => {
        if (status === "error" && error) errors.push(error);
      });

      await syncAccount("a1");
      unsub();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("authentication failed for user@test.com");
      expect(errors[0]).not.toBe("Unknown error");
    });

    it("handles null/undefined errors gracefully", async () => {
      const account = makeGmailAccount("a1", "100");
      mockGetAccount.mockResolvedValue(account);
      mockDeltaSync.mockRejectedValue(null);

      const errors: string[] = [];
      const unsub = onSyncStatus((_id, status, _progress, error) => {
        if (status === "error" && error) errors.push(error);
      });

      await syncAccount("a1");
      unsub();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("Unknown error");
    });
  });

  describe("Gmail's quota", () => {
    it("a delta sync held by the quota is no error: the account stays synced, nothing to reconnect", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));
      mockDeltaSync.mockRejectedValue(new GmailRateLimitError("Gmail API error: 403 rateLimitExceeded"));
      const statuses: { status: string; error?: string }[] = [];
      const off = onSyncStatus((_id, status, _progress, error) => void statuses.push({ status, error }));

      await syncAccount("a1");
      off();

      expect(statuses.map((s) => s.status)).toEqual(["done"]);
      expect(statuses.every((s) => s.error === undefined)).toBe(true);
    });

    it("a first sync held by the quota keeps syncing, to be tried at the next interval", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1"));
      mockInitialSync.mockRejectedValue(new GmailRateLimitError("quota"));
      const statuses: string[] = [];
      const off = onSyncStatus((_id, status) => void statuses.push(status));

      await syncAccount("a1");
      off();

      expect(statuses).toEqual(["syncing", "syncing"]);
    });

    it("an Outlook first sync still paging counts as syncing, not done, and its mail so far is shown", async () => {
      mockGetAccount.mockResolvedValue({
        ...makeGmailAccount("o1"),
        provider: "graph",
        graph_next_link: "https://graph/delta?$skiptoken=40",
      });
      vi.mocked(syncGraphAccount).mockResolvedValue(true);
      const statuses: { status: string; phase?: string; error?: string }[] = [];
      const off = onSyncStatus((_id, status, progress, error) => void statuses.push({ status, phase: progress?.phase, error }));

      await syncAccount("o1");
      off();

      expect(statuses).toEqual([
        { status: "syncing", phase: undefined, error: undefined },
        { status: "syncing", phase: "done", error: undefined },
      ]);
    });

    it("Outlook throttling is no error either: a synced account stays synced", async () => {
      mockGetAccount.mockResolvedValue({ ...makeGmailAccount("o1", "https://graph/delta"), provider: "graph" });
      vi.mocked(syncGraphAccount).mockRejectedValue(new GraphThrottledError("Microsoft Graph GET failed (429)"));
      const statuses: { status: string; error?: string }[] = [];
      const off = onSyncStatus((_id, status, _progress, error) => void statuses.push({ status, error }));

      await syncAccount("o1");
      off();

      expect(statuses).toEqual([{ status: "done", error: undefined }]);
    });
  });
});
