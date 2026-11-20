import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(),
  withTransaction: vi.fn(),
}));
const provider = {
  archive: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
};
vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(async () => provider),
}));
const gmail = {
  listLabels: vi.fn(async () => ({
    labels: [] as { id: string; name: string }[],
  })),
  createLabel: vi.fn(async (name: string) => ({ id: "Label_9", name })),
};
vi.mock("@/services/gmail/tokenManager", () => ({
  getGmailClient: vi.fn(async () => gmail),
}));
vi.mock("@/services/emailActions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/emailActions")>();
  return {
    ...actual,
    archiveThread: vi.fn(actual.archiveThread),
    addThreadLabel: vi.fn(actual.addThreadLabel),
    removeThreadLabel: vi.fn(actual.removeThreadLabel),
    unarchiveThread: vi.fn(actual.unarchiveThread),
  };
});

import { getDb } from "@/services/db/connection";
import { setThreadLabels } from "@/services/db/threads";
import {
  addThreadLabel,
  archiveThread,
  removeThreadLabel,
} from "@/services/emailActions";
import { useUIStore } from "@/stores/uiStore";
import {
  SNOOZE_LABEL_NAME,
  SnoozeLabelUnavailable,
  cancelRemind,
  checkSnoozedThreads,
  ensureSnoozeLabel,
  recoverOrphanSnoozes,
  remindLater,
  syncedSnooze,
} from "./snoozeManager";

let sqlite: DatabaseSync;
const key = { accountId: "a", threadId: "t1" };

function seed(
  accountId: string,
  id: string,
  labels: string[],
  snooze?: number | null,
) {
  sqlite
    .prepare(
      "INSERT INTO threads (id, account_id, is_snoozed, snooze_until) VALUES (?, ?, ?, ?)",
    )
    .run(id, accountId, snooze === undefined ? 0 : 1, snooze ?? null);
  for (const l of labels) {
    sqlite
      .prepare(
        "INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES (?, ?, ?)",
      )
      .run(id, accountId, l);
  }
}

const labelsOf = (accountId: string, threadId: string) =>
  (
    sqlite
      .prepare(
        "SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id",
      )
      .all(accountId, threadId) as { label_id: string }[]
  ).map((r) => r.label_id);

const snoozeOf = (accountId: string, threadId: string) =>
  sqlite
    .prepare(
      "SELECT is_snoozed, snooze_until FROM threads WHERE account_id = ? AND id = ?",
    )
    .get(accountId, threadId);

beforeEach(async () => {
  vi.clearAllMocks();
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT, provider TEXT DEFAULT 'gmail_api',
      access_token TEXT, refresh_token TEXT, imap_password TEXT);
    CREATE TABLE threads (id TEXT NOT NULL, account_id TEXT NOT NULL, is_snoozed INTEGER DEFAULT 0,
      snooze_until INTEGER, PRIMARY KEY (account_id, id));
    CREATE TABLE thread_labels (thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL,
      PRIMARY KEY (account_id, thread_id, label_id));
    CREATE TABLE labels (id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
      PRIMARY KEY (account_id, id));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE pending_operations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, operation_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 10, next_retry_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()), error_message TEXT);
    INSERT INTO accounts (id, email) VALUES ('a', 'me@home.com');
    INSERT INTO accounts (id, email, provider) VALUES ('i', 'me@imap.com', 'imap');
  `);
  const toQmark = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(toQmark(sql)).all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) => {
      const r = sqlite.prepare(toQmark(sql)).run(...(params as never[]));
      return { rowsAffected: Number(r.changes) };
    },
  } as unknown as Awaited<ReturnType<typeof getDb>>);
  useUIStore.setState({ isOnline: true });
});

describe("ensureSnoozeLabel", () => {
  it("creates the voa label once and caches its id", async () => {
    expect(await ensureSnoozeLabel("a")).toBe("Label_9");
    expect(await ensureSnoozeLabel("a")).toBe("Label_9");
    expect(gmail.createLabel).toHaveBeenCalledTimes(1);
    expect(gmail.createLabel).toHaveBeenCalledWith(SNOOZE_LABEL_NAME);
  });

  it("reuses the label Gmail already has (a lost database)", async () => {
    gmail.listLabels.mockResolvedValueOnce({
      labels: [{ id: "Label_3", name: SNOOZE_LABEL_NAME }],
    });
    expect(await ensureSnoozeLabel("a")).toBe("Label_3");
    expect(gmail.createLabel).not.toHaveBeenCalled();
  });
});

describe("remind me", () => {
  it("remindLater archives and labels in Gmail", async () => {
    seed("a", "t1", ["INBOX"]);
    await remindLater(key, ["m1"], 5000);
    expect(archiveThread).toHaveBeenCalledWith("a", "t1", ["m1"]);
    expect(addThreadLabel).toHaveBeenCalledWith("a", "t1", "Label_9");
    expect(provider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    expect(provider.addLabel).toHaveBeenCalledWith("t1", "Label_9");
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 1, snooze_until: 5000 });
    expect(labelsOf("a", "t1")).toEqual(["Label_9", "SNOOZED"]);
  });

  it("without the label (offline, first use) nothing changes and the error says so", async () => {
    seed("a", "t1", ["INBOX"]);
    gmail.listLabels.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(remindLater(key, ["m1"], 5000)).rejects.toBeInstanceOf(SnoozeLabelUnavailable);
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 0, snooze_until: null });
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("snoozing a snoozed thread again only moves its time", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "t1", ["Label_9", "SNOOZED"], 5000);
    await remindLater(key, ["m1"], 9000);
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 1, snooze_until: 9000 });
    expect(archiveThread).not.toHaveBeenCalled();
    expect(addThreadLabel).not.toHaveBeenCalled();
    expect(labelsOf("a", "t1")).toEqual(["Label_9", "SNOOZED"]);
  });

  it("a label the owner deleted in Gmail is found again and the add retried once", async () => {
    await ensureSnoozeLabel("a"); // caches Label_9
    seed("a", "t1", ["INBOX"]);
    provider.addLabel.mockRejectedValueOnce(new Error("400 Invalid label: Label_9"));
    gmail.createLabel.mockResolvedValueOnce({ id: "Label_10", name: SNOOZE_LABEL_NAME });
    await remindLater(key, ["m1"], 5000);
    expect(provider.addLabel.mock.calls).toEqual([
      ["t1", "Label_9"],
      ["t1", "Label_10"],
    ]);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'snooze_label_id:a'").get()).toEqual({ value: "Label_10" });
    expect(labelsOf("a", "t1")).toEqual(["Label_10", "SNOOZED"]);
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 1, snooze_until: 5000 });
  });

  it("returning a thread whose label no longer exists counts it as removed", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "t1", ["Label_9", "SNOOZED"], 5000);
    provider.removeLabel.mockRejectedValueOnce(new Error("400 Invalid label: Label_9"));
    await expect(cancelRemind(key, ["m1"])).resolves.toBeUndefined();
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 0, snooze_until: null });
  });

  it("a remove Gmail refuses while the label exists still fails", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "t1", ["Label_9", "SNOOZED"], 5000);
    provider.removeLabel.mockRejectedValueOnce(new Error("400 Bad Request"));
    gmail.listLabels.mockResolvedValueOnce({ labels: [{ id: "Label_9", name: SNOOZE_LABEL_NAME }] });
    await expect(cancelRemind(key, ["m1"])).rejects.toThrow();
  });

  it("an IMAP account snoozes locally and archives, with no Gmail label", async () => {
    seed("i", "t1", ["INBOX"]);
    await remindLater({ accountId: "i", threadId: "t1" }, ["m1"], 5000);
    expect(archiveThread).toHaveBeenCalledWith("i", "t1", ["m1"]);
    expect(addThreadLabel).not.toHaveBeenCalled();
    expect(labelsOf("i", "t1")).toEqual(["SNOOZED"]);
  });

  it("an archive Gmail refuses leaves the thread in the inbox", async () => {
    seed("a", "t1", ["INBOX"]);
    provider.archive.mockRejectedValueOnce(new Error("400 Bad Request"));
    await expect(remindLater(key, ["m1"], 5000)).rejects.toThrow();
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 0, snooze_until: null });
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(addThreadLabel).not.toHaveBeenCalled();
  });

  it("cancelRemind restores the thread", async () => {
    seed("a", "t1", ["INBOX"]);
    await remindLater(key, ["m1"], 5000);
    await cancelRemind(key, ["m1"]);
    expect(provider.addLabel).toHaveBeenCalledWith("t1", "INBOX");
    expect(removeThreadLabel).toHaveBeenCalledWith("a", "t1", "Label_9");
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 0, snooze_until: null });
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
  });

  it("cancelRemind while offline drops the queued archive and label", async () => {
    seed("a", "t1", ["INBOX"]);
    await ensureSnoozeLabel("a");
    useUIStore.setState({ isOnline: false });
    await remindLater(key, ["m1"], 5000);
    await cancelRemind(key, ["m1"]);
    const ops = sqlite
      .prepare("SELECT operation_type FROM pending_operations ORDER BY rowid")
      .all();
    expect(ops).toEqual([
      { operation_type: "addLabel" },
      { operation_type: "removeLabel" },
    ]); // compactQueue cancels the pair
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(provider.archive).not.toHaveBeenCalled();
  });
});

describe("checkSnoozedThreads", () => {
  it("returns due threads to INBOX in Gmail", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "due", ["Label_9", "SNOOZED"], 100);
    seed("a", "later", ["Label_9", "SNOOZED"], 9_999_999_999);
    await checkSnoozedThreads();
    expect(provider.addLabel).toHaveBeenCalledWith("due", "INBOX");
    expect(removeThreadLabel).toHaveBeenCalledWith("a", "due", "Label_9");
    expect(provider.removeLabel).toHaveBeenCalledWith("due", "Label_9");
    expect(snoozeOf("a", "due")).toEqual({ is_snoozed: 0, snooze_until: null });
    expect(labelsOf("a", "due")).toEqual(["INBOX"]);
    expect(provider.addLabel).not.toHaveBeenCalledWith(
      "later",
      expect.anything(),
    );
    expect(snoozeOf("a", "later")).toEqual({
      is_snoozed: 1,
      snooze_until: 9_999_999_999,
    });
    expect(labelsOf("a", "later")).toEqual(["Label_9", "SNOOZED"]);
  });
});

describe("recoverOrphanSnoozes", () => {
  it("returns labeled threads without time", async () => {
    sqlite.exec(
      "INSERT INTO labels (id, account_id, name, type) VALUES ('Label_3', 'a', 'voa/Snoozed', 'user')",
    );
    seed("a", "orphan", ["Label_3"]);
    seed("a", "kept", ["Label_3", "SNOOZED"], 9_999_999_999);
    seed("a", "plain", []);
    expect(await recoverOrphanSnoozes()).toBe(1);
    expect(provider.addLabel).toHaveBeenCalledWith("orphan", "INBOX");
    expect(provider.removeLabel).toHaveBeenCalledWith("orphan", "Label_3");
    expect(labelsOf("a", "orphan")).toEqual(["INBOX"]);
    expect(labelsOf("a", "kept")).toEqual(["Label_3", "SNOOZED"]);
    expect(labelsOf("a", "plain")).toEqual([]);
  });
});

describe("sync", () => {
  it("sync clears snooze when Gmail shows the thread back in INBOX", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "t1", ["Label_9", "SNOOZED"], 9_999_999_999);
    // What processAndStoreThread does with Gmail's labels.
    await setThreadLabels("a", "t1", ["INBOX", "Label_9", "UNREAD"]);
    await syncedSnooze("a", "t1", ["INBOX", "Label_9", "UNREAD"]);
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 0, snooze_until: null });
    expect(removeThreadLabel).toHaveBeenCalledWith("a", "t1", "Label_9");
    expect(labelsOf("a", "t1")).toEqual(["INBOX", "UNREAD"]);
  });

  it("INBOX without the voa label (a sync that read the thread before our archive) keeps the snooze", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "t1", ["SNOOZED"], 9_999_999_999);
    await setThreadLabels("a", "t1", ["INBOX", "UNREAD"]);
    await syncedSnooze("a", "t1", ["INBOX", "UNREAD"]);
    expect(snoozeOf("a", "t1")).toEqual({ is_snoozed: 1, snooze_until: 9_999_999_999 });
    expect(labelsOf("a", "t1")).toEqual(["INBOX", "SNOOZED", "UNREAD"]);
    expect(removeThreadLabel).not.toHaveBeenCalled();
  });

  it("a sync that still sees the thread archived keeps it snoozed", async () => {
    await ensureSnoozeLabel("a");
    seed("a", "t1", ["Label_9", "SNOOZED"], 9_999_999_999);
    await setThreadLabels("a", "t1", ["Label_9"]);
    await syncedSnooze("a", "t1", ["Label_9"]);
    expect(snoozeOf("a", "t1")).toEqual({
      is_snoozed: 1,
      snooze_until: 9_999_999_999,
    });
    expect(labelsOf("a", "t1")).toEqual(["Label_9", "SNOOZED"]);
    expect(removeThreadLabel).not.toHaveBeenCalled();
  });
});
