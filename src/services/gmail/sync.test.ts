import { describe, it, expect, vi, beforeEach } from "vitest";
import { catchUpSent, catchUpSpam, continueBackfill, deltaSync, fetchGmailBodies, initialSync, sentCatchupKey, spamCatchupKey, storeQueryThreads } from "./sync";
import { GmailClient } from "./client";
import { GmailRateLimitError } from "./quota";

// Mock all DB modules
const stored = new Set<string>();
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(async (t: { id: string }) => {
    stored.add(t.id);
  }),
  setThreadLabels: vi.fn(),
  addLocalLabel: vi.fn(),
  getThreadById: vi.fn(async (_a: string, id: string) => (stored.has(id) ? { id } : undefined)),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
  setMessageBody: vi.fn(),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  updateAccountSyncState: vi.fn(),
  getAccount: vi.fn(async (id: string) => ({ id })),
}));
const settings = new Map<string, string>();
vi.mock("../db/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  }),
  deleteSetting: vi.fn(async (key: string) => {
    settings.delete(key);
  }),
}));
vi.mock("@/services/db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn().mockResolvedValue([]),
}));

const mockSyncedSnooze = vi.fn();
const mockRecover = vi.fn(async () => 0);
vi.mock("@/services/snooze/snoozeManager", () => ({
  SNOOZE_LABEL_NAME: "voa/Snoozed",
  syncedSnooze: (...args: unknown[]) => mockSyncedSnooze(...args),
  recoverOrphanSnoozes: () => mockRecover(),
}));
vi.mock("../db/labels", () => ({ upsertLabel: vi.fn() }));
vi.mock("../db/blockedSenders", () => ({
  getBlockedAddresses: vi.fn().mockResolvedValue(new Set()),
}));

// Mock parseGmailMessage
vi.mock("./messageParser", () => ({
  parseGmailMessage: (msg: { id: string; threadId: string; labelIds: string[]; from?: string }) => ({
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    fromAddress: msg.from ?? "sender@example.com",
    fromName: "Sender",
    toAddresses: "me@example.com",
    ccAddresses: "",
    bccAddresses: "",
    replyTo: "",
    subject: `Subject for ${msg.id}`,
    snippet: "snippet",
    date: "2024-01-01T00:00:00Z",
    isRead: !msg.labelIds?.includes("UNREAD"),
    isStarred: false,
    bodyHtml: "<p>test</p>",
    bodyText: "test",
    rawSize: 100,
    internalDate: "1704067200000",
    hasAttachments: false,
    attachments: [],
  }),
}));

function createMockClient(historyItems: unknown[], labelIds = ["INBOX", "UNREAD"]): GmailClient {
  return {
    getHistory: vi.fn().mockResolvedValue({
      history: historyItems,
      historyId: "200",
    }),
    getThread: vi.fn().mockImplementation((threadId: string) =>
      Promise.resolve({
        id: threadId,
        historyId: "200",
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            labelIds,
            snippet: "test",
            historyId: "200",
            internalDate: "1704067200000",
            payload: { partId: "", mimeType: "text/plain", filename: "", headers: [], body: { size: 0 } },
            sizeEstimate: 100,
          },
        ],
      }),
    ),
  } as unknown as GmailClient;
}

describe("deltaSync", () => {
  it("stores a new inbox message with its labels", async () => {
    const client = createMockClient([
      { id: "100", messagesAdded: [{ message: { id: "msg-thread-1", threadId: "thread-1", labelIds: ["INBOX", "UNREAD"] } }] },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockSyncedSnooze).toHaveBeenCalledWith("account-1", "thread-1", ["INBOX", "UNREAD"]);
  });
});

function initialClient(lists: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  const base = createMockClient([]);
  const listThreads = vi.fn(async (params: { q?: string; labelIds?: string[] }) => ({
    threads: (lists[params.q ?? params.labelIds![0]!] ?? []).map((id) => ({ id })),
  }));
  const client = {
    ...base,
    listLabels: vi.fn().mockResolvedValue({ labels: [{ id: "Label_9", name: "voa/Snoozed", type: "user" }] }),
    getProfile: vi.fn().mockResolvedValue({ historyId: "150" }),
    listThreads,
    ...extra,
  } as unknown as GmailClient;
  return { client, listThreads, getThread: vi.mocked(base.getThread) };
}

describe("initialSync", () => {
  beforeEach(async () => {
    stored.clear();
    settings.clear();
    mockRecover.mockClear();
    vi.mocked((await import("../db/accounts")).updateAccountSyncState).mockClear();
  });

  it("brings orphaned snoozes back once the threads are stored (a lost database)", async () => {
    const { upsertThread } = await import("../db/threads");
    const { updateAccountSyncState } = await import("../db/accounts");
    const { client } = initialClient({ INBOX: ["thread-1"] });

    await initialSync(client, "account-1", 30);

    expect(mockRecover).toHaveBeenCalledTimes(1);
    const recoveredAt = mockRecover.mock.invocationCallOrder[0]!;
    expect(vi.mocked(upsertThread).mock.invocationCallOrder[0]!).toBeLessThan(recoveredAt);
    expect(vi.mocked(updateAccountSyncState).mock.invocationCallOrder.at(-1)!).toBeLessThan(recoveredAt);
    await continueBackfill(client, "account-1");
  });

  it("reads the profile's history id first and stores it once the inbox, starred and snoozed threads are in", async () => {
    const { updateAccountSyncState } = await import("../db/accounts");
    // Empty threads: only what is listed and fetched counts here (vitest's mocks do not survive
    // several threads storing at once through sync.ts's dynamic imports).
    const getThread = vi.fn(async (id: string) => ({ id, historyId: "200", messages: [] }));
    const { client, listThreads } = initialClient(
      { INBOX: ["inbox", "both"], STARRED: ["both", "starred"], Label_9: ["snoozed"] },
      { getThread },
    );

    await initialSync(client, "account-1", 365);

    expect(vi.mocked(client.getProfile).mock.invocationCallOrder[0]!).toBeLessThan(listThreads.mock.invocationCallOrder[0]!);
    // The backfill's listing of the year comes only after.
    expect(listThreads.mock.calls.map((c) => c[0].labelIds?.[0] ?? c[0].q?.split(":")[0])).toEqual([
      "INBOX",
      "STARRED",
      "SENT",
      "SPAM",
      "TRASH",
      "Label_9",
      "after",
    ]);
    expect(getThread.mock.calls.map((c) => c[0]).sort()).toEqual(["both", "inbox", "snoozed", "starred"]);
    expect(updateAccountSyncState).toHaveBeenCalledWith("account-1", "150");
    await continueBackfill(client, "account-1");
  });

  it("stores the history id before the backfill, which then reads the rest of the days without holding it", async () => {
    const { updateAccountSyncState } = await import("../db/accounts");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { client, getThread } = initialClient({ INBOX: ["inbox"] });
    vi.mocked(client.listThreads).mockImplementation(async (params: { q?: string; labelIds?: string[] }) => {
      if (params.q) {
        await held;
        return { threads: [{ id: "inbox" }, { id: "old" }] };
      }
      return { threads: params.labelIds?.[0] === "INBOX" ? [{ id: "inbox" }] : [] };
    });

    await initialSync(client, "account-1", 365);

    expect(updateAccountSyncState).toHaveBeenCalledWith("account-1", "150");
    expect(getThread.mock.calls.map((c) => c[0])).toEqual(["inbox"]);
    expect(settings.get("gmail_backfill_after:account-1")).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/);

    release();
    await continueBackfill(client, "account-1");
    expect(getThread.mock.calls.map((c) => c[0])).toEqual(["inbox", "old"]);
    expect(settings.has("gmail_backfill_after:account-1")).toBe(false);
  });

  it("the backfill skips a thread a delta sync stored meanwhile and one with a pending local action", async () => {
    const { getPendingOpsForResource } = await import("@/services/db/pendingOperations");
    vi.mocked(getPendingOpsForResource).mockImplementation(async (_a: string, id: string) =>
      id === "acted" ? ([{ id: "op" }] as never) : [],
    );
    settings.set("gmail_backfill_after:account-1", "2025/11/11");
    stored.add("changed");
    const { client, getThread } = initialClient({ "after:2025/11/11": ["changed", "acted", "old"] });

    await continueBackfill(client, "account-1");

    expect(getThread.mock.calls.map((c) => c[0])).toEqual(["old"]);
    vi.mocked(getPendingOpsForResource).mockResolvedValue([]);
  });

  it("a backfill cut short by a failed listing stays to be resumed", async () => {
    settings.set("gmail_backfill_after:account-1", "2025/11/11");
    const { client } = initialClient({}, { listThreads: vi.fn().mockRejectedValue(new Error("offline")) });

    await continueBackfill(client, "account-1");

    expect(settings.get("gmail_backfill_after:account-1")).toBe("2025/11/11");
  });

  it("an empty mailbox stores the profile's history id", async () => {
    const { updateAccountSyncState } = await import("../db/accounts");
    const { client } = initialClient({}, { getProfile: vi.fn().mockResolvedValue({ historyId: "777" }) });

    await initialSync(client, "account-1", 365);

    expect(updateAccountSyncState).toHaveBeenCalledWith("account-1", "777");
    await continueBackfill(client, "account-1");
  });

  it("when no thread could be fetched it fails and stores no history id", async () => {
    const { updateAccountSyncState } = await import("../db/accounts");
    const { client } = initialClient({ INBOX: ["x"] }, { getThread: vi.fn().mockRejectedValue(new Error("boom")) });

    await expect(initialSync(client, "account-1", 365)).rejects.toThrow();
    expect(updateAccountSyncState).not.toHaveBeenCalled();
    expect(settings.size).toBe(0);
  });

  it("marks spam catch-up done after a finished initial sync", async () => {
    const { client } = initialClient({});
    await initialSync(client, "account-1", 30);
    expect(settings.get(spamCatchupKey("account-1"))).toBe("1");
    expect(settings.get(sentCatchupKey("account-1"))).toBe("1");
  });
});

describe("catchUpSpam", () => {
  beforeEach(() => {
    stored.clear();
    settings.clear();
  });

  it("lists SPAM once and stores missing threads", async () => {
    const { client, listThreads, getThread } = initialClient({ SPAM: ["junk"] });

    await catchUpSpam(client, "account-1");

    expect(listThreads.mock.calls.map((c) => c[0].labelIds?.[0])).toEqual(["SPAM"]);
    expect(getThread).toHaveBeenCalledWith("junk", "full", { background: false });
    expect(settings.get(spamCatchupKey("account-1"))).toBe("1");

    listThreads.mockClear();
    await catchUpSpam(client, "account-1");
    expect(listThreads).not.toHaveBeenCalled();
  });
});

describe("catchUpSent", () => {
  beforeEach(() => {
    stored.clear();
    settings.clear();
  });

  it("lists SENT once and stores missing threads", async () => {
    const { client, listThreads, getThread } = initialClient({ SENT: ["out"] });

    await catchUpSent(client, "account-1");

    expect(listThreads.mock.calls.map((c) => c[0].labelIds?.[0])).toEqual(["SENT"]);
    expect(getThread).toHaveBeenCalledWith("out", "full", { background: false });
    expect(settings.get(sentCatchupKey("account-1"))).toBe("1");

    listThreads.mockClear();
    await catchUpSent(client, "account-1");
    expect(listThreads).not.toHaveBeenCalled();
  });
});

describe("storeQueryThreads", () => {
  beforeEach(() => {
    stored.clear();
    settings.clear();
  });

  it("stores an archived conversation Gmail matched with its headers only, and skips it once it is stored", async () => {
    const { upsertMessage } = await import("../db/messages");
    vi.mocked(upsertMessage).mockClear();
    const { client, listThreads, getThread } = initialClient({ hiago: ["archived"] });

    await storeQueryThreads(client, "account-1", "hiago");

    expect(listThreads).toHaveBeenCalledWith({ maxResults: 20, q: "hiago" });
    expect(getThread).toHaveBeenCalledWith("archived", "metadata", { background: false });
    expect(vi.mocked(upsertMessage).mock.calls.map((c) => c[0].bodyPending)).toEqual([true]);

    getThread.mockClear();
    await storeQueryThreads(client, "account-1", "hiago");
    expect(getThread).not.toHaveBeenCalled();
  });

  it("never changes a mailbox: no blocked-sender drop, no snooze ended, labels as Gmail has them", async () => {
    const { getBlockedAddresses } = await import("../db/blockedSenders");
    const { setThreadLabels, addLocalLabel } = await import("../db/threads");
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set(["sender@example.com"]));
    vi.mocked(setThreadLabels).mockClear();
    vi.mocked(addLocalLabel).mockClear();
    mockSyncedSnooze.mockClear();
    const modifyThread = vi.fn().mockResolvedValue({});
    const { client } = initialClient({ promo: ["inbox-promo"] }, { modifyThread });

    try {
      await storeQueryThreads(client, "account-1", "promo");
    } finally {
      vi.mocked(getBlockedAddresses).mockResolvedValue(new Set());
    }

    expect(stored.has("inbox-promo")).toBe(true);
    expect(modifyThread).not.toHaveBeenCalled();
    expect(addLocalLabel).not.toHaveBeenCalled();
    expect(mockSyncedSnooze).not.toHaveBeenCalled();
    expect(vi.mocked(setThreadLabels).mock.calls).toEqual([["account-1", "inbox-promo", ["INBOX", "UNREAD"]]]);
  });

  it("an aborted search asks for nothing more", async () => {
    const { client, getThread } = initialClient({ hiago: ["late"] });
    const controller = new AbortController();
    controller.abort();

    await storeQueryThreads(client, "account-1", "hiago", controller.signal);

    expect(getThread).not.toHaveBeenCalled();
    expect(stored.has("late")).toBe(false);
  });
});

describe("fetchGmailBodies", () => {
  it("reads the full conversation and writes only its bodies and files", async () => {
    const { setMessageBody, upsertMessage } = await import("../db/messages");
    vi.mocked(upsertMessage).mockClear();
    const client = createMockClient([]);

    await fetchGmailBodies(client, "account-1", "t1");

    expect(client.getThread).toHaveBeenCalledWith("t1", "full");
    expect(setMessageBody).toHaveBeenCalledWith("account-1", "msg-t1", "<p>test</p>", "test");
    expect(upsertMessage).not.toHaveBeenCalled();
  });
});

describe("Gmail's quota", () => {
  beforeEach(async () => {
    stored.clear();
    settings.clear();
    vi.mocked((await import("../db/accounts")).updateAccountSyncState).mockClear();
  });

  const refusedOnce = (ids: string[], inner: (id: string) => Promise<unknown>) => {
    const refused = new Set<string>();
    return vi.fn(async (id: string, _format?: string, opts?: { background?: boolean }) => {
      if (ids.includes(id) && !refused.has(id)) {
        refused.add(id);
        throw new GmailRateLimitError("Gmail API error: 403 rateLimitExceeded");
      }
      void opts;
      return inner(id);
    });
  };

  it("the backfill reads a thread the quota refused again, paced, instead of dropping it", async () => {
    settings.set("gmail_backfill_after:account-1", "2025/11/11");
    const { client, getThread: base } = initialClient({ "after:2025/11/11": ["a", "b", "c"] });
    const getThread = refusedOnce(["b"], (id) => base(id));
    (client as unknown as { getThread: typeof getThread }).getThread = getThread;

    await continueBackfill(client, "account-1");

    expect(getThread.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c", "b"]);
    expect(getThread.mock.calls.every((c) => c[2]?.background === true)).toBe(true);
    expect(stored.has("b")).toBe(true);
    expect(settings.has("gmail_backfill_after:account-1")).toBe(false);
  });

  it("the backfill keeps what the quota still refuses for the next sync's resume", async () => {
    settings.set("gmail_backfill_after:account-1", "2025/11/11");
    const { client, getThread: base } = initialClient({ "after:2025/11/11": ["a", "b"] });
    const getThread = vi.fn(async (id: string) => {
      if (id === "b") throw new GmailRateLimitError("quota");
      return base(id);
    });
    (client as unknown as { getThread: typeof getThread }).getThread = getThread;

    await continueBackfill(client, "account-1");

    expect(stored.has("a")).toBe(true);
    expect(settings.get("gmail_backfill_after:account-1")).toBe("2025/11/11");
  });

  it("a delta sync whose threads the quota still refuses keeps its history id, so the changes are read again", async () => {
    const { updateAccountSyncState } = await import("../db/accounts");
    const client = createMockClient([{ id: "150", messagesAdded: [{ message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } }] }]);
    vi.mocked(client.getThread).mockRejectedValue(new GmailRateLimitError("quota"));

    await expect(deltaSync(client, "account-1", "100")).rejects.toBeInstanceOf(GmailRateLimitError);
    expect(updateAccountSyncState).not.toHaveBeenCalled();
  });

  it("a delta sync leaves a thread alone while a local change is still in flight", async () => {
    const { getPendingOpsForResource } = await import("../db/pendingOperations");
    const { setThreadLabels } = await import("../db/threads");
    vi.mocked(setThreadLabels).mockClear();
    vi.mocked(getPendingOpsForResource).mockResolvedValue([{ id: "op", status: "executing" } as never]);
    const client = createMockClient([
      { id: "150", labelsAdded: [{ message: { id: "m1", threadId: "t1", labelIds: ["SPAM"] } }] },
    ]);

    await deltaSync(client, "account-1", "100");

    expect(client.getThread).not.toHaveBeenCalled();
    expect(setThreadLabels).not.toHaveBeenCalled();
    vi.mocked(getPendingOpsForResource).mockResolvedValue([]);
  });

  it("a delta sync takes a blocked sender out of the inbox", async () => {
    const { getBlockedAddresses } = await import("../db/blockedSenders");
    const { setThreadLabels } = await import("../db/threads");
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set(["sender@example.com"]));
    vi.mocked(setThreadLabels).mockClear();
    const client = createMockClient([
      { id: "150", messagesAdded: [{ message: { id: "msg-t1", threadId: "t1", labelIds: ["INBOX", "UNREAD"] } }] },
    ]);
    const modifyThread = vi.fn().mockResolvedValue({});
    (client as unknown as { modifyThread: typeof modifyThread }).modifyThread = modifyThread;

    await deltaSync(client, "account-1", "100");

    expect(modifyThread).toHaveBeenCalledWith("t1", undefined, ["INBOX"]);
    const labels = vi.mocked(setThreadLabels).mock.calls.at(-1)?.[2] as string[];
    expect(labels).not.toContain("INBOX");
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set());
  });

  it("a blocked sender's mail leaves the inbox only when the latest message is theirs", async () => {
    const { getBlockedAddresses } = await import("../db/blockedSenders");
    const { setThreadLabels, addLocalLabel } = await import("../db/threads");
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set(["sender@example.com"]));
    vi.mocked(setThreadLabels).mockClear();
    vi.mocked(addLocalLabel).mockClear();
    const client = createMockClient([
      { id: "150", messagesAdded: [{ message: { id: "msg-t2", threadId: "t2", labelIds: ["INBOX", "UNREAD"] } }] },
    ]);
    const message = (id: string, from: string) => ({ id, threadId: "t2", labelIds: ["INBOX", "UNREAD"], from, payload: { headers: [] } });
    vi.mocked(client.getThread).mockResolvedValue({
      id: "t2",
      historyId: "200",
      messages: [message("msg-old", "sender@example.com"), message("msg-t2", "friend@example.com")],
    } as never);
    const modifyThread = vi.fn().mockResolvedValue({});
    (client as unknown as { modifyThread: typeof modifyThread }).modifyThread = modifyThread;

    await deltaSync(client, "account-1", "100");

    expect(modifyThread).not.toHaveBeenCalled();
    expect(vi.mocked(setThreadLabels).mock.calls.at(-1)?.[2]).toContain("INBOX");
    expect(addLocalLabel).not.toHaveBeenCalled();
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set());
  });

  it("marks what it took out of the inbox for a block, so Unblock brings it back", async () => {
    const { getBlockedAddresses } = await import("../db/blockedSenders");
    const { addLocalLabel } = await import("../db/threads");
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set(["sender@example.com"]));
    vi.mocked(addLocalLabel).mockClear();
    const client = createMockClient([
      { id: "150", messagesAdded: [{ message: { id: "msg-t3", threadId: "t3", labelIds: ["INBOX", "UNREAD"] } }] },
    ]);
    (client as unknown as { modifyThread: unknown }).modifyThread = vi.fn().mockResolvedValue({});

    await deltaSync(client, "account-1", "100");

    expect(addLocalLabel).toHaveBeenCalledWith("account-1", "t3", "BLOCKED");
    vi.mocked(getBlockedAddresses).mockResolvedValue(new Set());
  });

  it("a rate limit on the history itself is no expired history", async () => {
    const client = createMockClient([]);
    vi.mocked(client.getHistory).mockRejectedValue(new GmailRateLimitError("Gmail API error: 403 historyId 404"));

    await expect(deltaSync(client, "account-1", "100")).rejects.toBeInstanceOf(GmailRateLimitError);
  });
});

