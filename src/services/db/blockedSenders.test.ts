import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

let sqlite: DatabaseSync;

vi.mock("./connection", () => ({
  getDb: async () => ({
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql.replace(/\$(\d+)/g, "?$1")).all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) => {
      sqlite.prepare(sql.replace(/\$(\d+)/g, "?$1")).run(...(params as never[]));
      return { rowsAffected: 0 };
    },
  }),
}));

const { blockSender, unblockSender, getBlockedAddresses, inboxThreadIdsFromSender, blockedThreadIdsFromSender, listBlockedSenders } = await import("./blockedSenders");

describe("blocked senders", () => {
  beforeEach(async () => {
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE blocked_senders (
        account_id TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, address)
      );
      CREATE TABLE threads (id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY (account_id, id));
      CREATE TABLE thread_labels (
        thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id, label_id)
      );
      CREATE TABLE messages (
        id TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        from_address TEXT, date INTEGER NOT NULL
      );
    `);
  });

  it("stores the address once, in lower case, and forgets it", async () => {
    await blockSender("acc", "Spam@List.com");
    await blockSender("acc", "spam@list.com");
    expect([...(await getBlockedAddresses("acc"))]).toEqual(["spam@list.com"]);
    await unblockSender("acc", "SPAM@list.com");
    expect(await getBlockedAddresses("acc")).toEqual(new Set());
  });

  it("lists inbox threads whose latest message is from the sender", async () => {
    sqlite.exec(`
      INSERT INTO threads (id, account_id) VALUES ('in', 'acc'), ('other', 'acc'), ('junk', 'acc');
      INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES
        ('in', 'acc', 'INBOX'), ('other', 'acc', 'INBOX'), ('junk', 'acc', 'SPAM');
      INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES
        ('m1', 'acc', 'in', 'Ads@News.com', 1),
        ('m2', 'acc', 'other', 'person@x.com', 2),
        ('m3', 'acc', 'junk', 'ads@news.com', 3);
    `);
    expect(await inboxThreadIdsFromSender("acc", "ads@news.com")).toEqual(["in"]);
  });

  it("leaves out a conversation where someone else wrote after the sender", async () => {
    sqlite.exec(`
      INSERT INTO threads (id, account_id) VALUES ('theirs', 'acc'), ('replied', 'acc');
      INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES ('theirs', 'acc', 'INBOX'), ('replied', 'acc', 'INBOX');
      INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES
        ('m1', 'acc', 'theirs', 'friend@x.com', 1),
        ('m2', 'acc', 'theirs', 'ads@news.com', 2),
        ('m3', 'acc', 'replied', 'ads@news.com', 3),
        ('m4', 'acc', 'replied', 'friend@x.com', 4);
    `);
    expect(await inboxThreadIdsFromSender("acc", "ads@news.com")).toEqual(["theirs"]);
  });

  it("lists who is blocked, and the conversations a block set aside", async () => {
    await blockSender("acc", "ads@news.com");
    sqlite.exec(`
      INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES ('m1', 'acc', 'in', 'ads@news.com', 1);
      INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES ('in', 'acc', 'BLOCKED');
    `);
    expect(await listBlockedSenders()).toEqual([{ account_id: "acc", address: "ads@news.com" }]);
    expect(await blockedThreadIdsFromSender("acc", "ADS@news.com")).toEqual(["in"]);
  });
});
