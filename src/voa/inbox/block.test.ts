import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(),
  selectFirstBy: async (sql: string, params: unknown[]) => (await asDb(sqlite).select<unknown[]>(sql, params))[0] ?? null,
}));
vi.mock("@/services/badgeManager", () => ({ updateBadgeCount: vi.fn(async () => {}) }));
const provider = { archive: vi.fn(async () => {}), addLabel: vi.fn(async () => {}) };
vi.mock("@/services/email/providerFactory", () => ({ getEmailProvider: vi.fn(async () => provider) }));
const restoreGraphSender = vi.fn(async (_accountId: string, _address: string) => [] as string[]);
vi.mock("@/services/graph/sync", () => ({ restoreGraphSender: (accountId: string, address: string) => restoreGraphSender(accountId, address) }));

import { getDb } from "@/services/db/connection";
import { asDb, createInboxDb, seed } from "./inboxDb.test-helper";
import { realSource } from "./source";

let sqlite: DatabaseSync;
const addMessage = (thread: string, id: string, from: string, at: number) =>
  sqlite
    .prepare("INSERT INTO messages (id, account_id, thread_id, from_address, date, message_id_header) VALUES (?, 'a', ?, ?, ?, ?)")
    .run(id, thread, from, at, `<${id}@x>`);
const recorded = () => (sqlite.prepare("SELECT message_id_header FROM blocked_messages ORDER BY 1").all() as { message_id_header: string }[]).map((r) => r.message_id_header);
const blocked = () => sqlite.prepare("SELECT address FROM blocked_senders").all() as { address: string }[];

beforeEach(async () => {
  vi.clearAllMocks();
  sqlite = await createInboxDb();
  sqlite.exec("CREATE TABLE send_as_aliases (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, email TEXT NOT NULL, UNIQUE(account_id, email))");
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
});

describe("block", () => {
  it("never takes the owner's own send-as alias for the sender", async () => {
    sqlite.exec("INSERT INTO send_as_aliases (id, account_id, email) VALUES ('x', 'a', 'Me@Alias.com')");
    seed(sqlite, "a", "t1", 1, ["INBOX"]);
    addMessage("t1", "m-from-friend", "friend@x.com", 2);
    addMessage("t1", "m-my-reply", "me@alias.com", 3);

    const { address } = await realSource.block({ accountId: "a", threadId: "t1" });

    expect(address).toBe("friend@x.com");
    expect(blocked()).toEqual([{ address: "friend@x.com" }]);
  });

  it("archives the conversation asked for and the sender's own, never one where someone else wrote last", async () => {
    seed(sqlite, "a", "t1", 1, ["INBOX"]);
    addMessage("t1", "m1", "ads@news.com", 2);
    seed(sqlite, "a", "t2", 1, ["INBOX"]);
    addMessage("t2", "m2", "ads@news.com", 2);
    addMessage("t2", "m3", "friend@x.com", 3);

    const { threads } = await realSource.block({ accountId: "a", threadId: "t1" });

    expect(threads).toEqual([{ accountId: "a", threadId: "t1" }]);
    expect(provider.archive).toHaveBeenCalledTimes(1);
  });

  it("records what it archived by Message-ID, and Unblock forgets it", async () => {
    seed(sqlite, "a", "t1", 1, ["INBOX"]);
    addMessage("t1", "m1", "ads@news.com", 2);

    await realSource.block({ accountId: "a", threadId: "t1" });
    expect(recorded()).toEqual(["<m1@x>"]);

    await realSource.unblock("a", "ads@news.com");
    expect(recorded()).toEqual([]);
  });

  it("on Outlook forgets only the Message-IDs Microsoft gave back", async () => {
    sqlite.exec("UPDATE accounts SET provider = 'graph' WHERE id = 'a'");
    sqlite.exec(
      "INSERT INTO blocked_messages (account_id, address, message_id_header) VALUES ('a', 'ads@news.com', '<back@x>'), ('a', 'ads@news.com', '<not-yet@x>')",
    );
    restoreGraphSender.mockResolvedValueOnce(["<back@x>"]);
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await realSource.unblock("a", "ads@news.com");
    } finally {
      delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    }
    expect(restoreGraphSender).toHaveBeenCalledWith("a", "ads@news.com");
    expect(recorded()).toEqual(["<not-yet@x>"]);
  });
});
