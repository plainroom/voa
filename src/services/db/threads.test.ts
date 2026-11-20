import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

import { getDb } from "@/services/db/connection";
import { getUnreadInboxCount, getThreads, getLabelCounts, getPromotionThreads } from "./threads";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("threads service - unified queries", () => {
  let sqlite: import("node:sqlite").DatabaseSync;

  // Real SQLite (node:sqlite) behind the getDb mock, so the SQL itself is tested.
  function seed(accountId: string, id: string, at: number, labels: string[]) {
    sqlite
      .prepare("INSERT INTO threads (id, account_id, last_message_at) VALUES (?, ?, ?)")
      .run(id, accountId, at);
    for (const l of labels) {
      sqlite
        .prepare("INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES (?, ?, ?)")
        .run(id, accountId, l);
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE threads (id TEXT NOT NULL, account_id TEXT NOT NULL, subject TEXT, snippet TEXT,
        last_message_at INTEGER, message_count INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0, is_important INTEGER DEFAULT 0, has_attachments INTEGER DEFAULT 0,
        is_snoozed INTEGER DEFAULT 0, snooze_until INTEGER, is_pinned INTEGER DEFAULT 0,
        is_muted INTEGER DEFAULT 0, PRIMARY KEY (account_id, id));
      CREATE TABLE thread_labels (thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id, label_id));
      CREATE TABLE messages (id TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        from_name TEXT, from_address TEXT, date INTEGER NOT NULL, body_text TEXT, body_html TEXT);
      CREATE TABLE blocked_senders (account_id TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (account_id, address));
    `);
    const toQmark = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
    vi.mocked(getDb).mockResolvedValue({
      select: async (sql: string, params: unknown[] = []) =>
        sqlite.prepare(toQmark(sql)).all(...(params as never[])),
    } as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it("getThreads returns INBOX threads of all accounts newest first", async () => {
    seed("acc1", "t1", 100, ["INBOX"]);
    seed("acc2", "t2", 200, ["INBOX"]);
    seed("acc1", "t3", 300, ["SENT"]);
    const rows = await getThreads({ labelId: "INBOX" });
    expect(rows.map((r) => r.id)).toEqual(["t2", "t1"]);
  });

  it("getThreads DONE lists received conversations in no list: not one only the owner wrote", async () => {
    sqlite.exec(`CREATE TABLE accounts (id TEXT, email TEXT); CREATE TABLE send_as_aliases (email TEXT);
      INSERT INTO accounts VALUES ('acc1', 'me@x.com'); INSERT INTO send_as_aliases VALUES ('alias@x.com');`);
    const from = (thread: string, address: string) =>
      sqlite.prepare("INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES (?, 'acc1', ?, ?, 1)").run(thread + address, thread, address);
    seed("acc1", "archived", 100, ["CATEGORY_UPDATES"]);
    from("archived", "ana@y.com");
    seed("acc1", "unlabeled", 200, []);
    from("unlabeled", "bob@y.com");
    for (const [id, labels] of [["inbox", ["INBOX"]], ["spam", ["SPAM"]], ["trash", ["TRASH"]], ["snoozed", ["SNOOZED"]]] as const) {
      seed("acc1", id, 300, [...labels]);
      from(id, "ana@y.com");
    }
    seed("acc1", "sentOnly", 400, ["SENT"]);
    from("sentOnly", "ME@x.com");
    from("sentOnly", "alias@x.com");
    const rows = await getThreads({ labelId: "DONE" });
    expect(rows.map((r) => r.id)).toEqual(["unlabeled", "archived"]);
  });

  it("getThreads filters by accountIds", async () => {
    seed("acc1", "t1", 100, ["INBOX"]);
    seed("acc2", "t2", 200, ["INBOX"]);
    const rows = await getThreads({ labelId: "INBOX", accountIds: ["acc2"] });
    expect(rows.map((r) => r.id)).toEqual(["t2"]);
  });

  it("getThreads keeps same thread id from two accounts", async () => {
    seed("acc1", "x", 100, ["INBOX"]);
    seed("acc2", "x", 200, ["INBOX"]);
    const rows = await getThreads({ labelId: "INBOX" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.account_id).sort()).toEqual(["acc1", "acc2"]);
  });

  it("getLabelCounts counts per account", async () => {
    seed("acc1", "t1", 100, ["INBOX"]);
    seed("acc2", "t2", 200, ["INBOX"]);
    seed("acc1", "t3", 300, ["SENT"]);
    expect(await getLabelCounts("INBOX")).toEqual({ acc1: 1, acc2: 1 });
  });

  it("getThreads returns SPAM threads", async () => {
    seed("acc1", "junk", 100, ["SPAM"]);
    seed("acc1", "ok", 200, ["INBOX"]);
    const rows = await getThreads({ labelId: "SPAM" });
    expect(rows.map((r) => r.id)).toEqual(["junk"]);
  });

  it("hides a blocked sender from the inbox and its count, and still lists them in Spam", async () => {
    seed("acc1", "ads", 100, ["INBOX"]);
    seed("acc1", "person", 200, ["INBOX"]);
    seed("acc1", "junk", 50, ["SPAM"]);
    sqlite.prepare("INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES (?, ?, ?, ?, ?)").run("m1", "acc1", "ads", "Ads@News.com", 100);
    sqlite.prepare("INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES (?, ?, ?, ?, ?)").run("m2", "acc1", "junk", "ads@news.com", 50);
    sqlite.prepare("INSERT INTO blocked_senders (account_id, address) VALUES (?, ?)").run("acc1", "ads@news.com");

    expect((await getThreads({ labelId: "INBOX" })).map((r) => r.id)).toEqual(["person"]);
    expect(await getLabelCounts("INBOX")).toEqual({ acc1: 1 });
    expect((await getThreads({ labelId: "SPAM" })).map((r) => r.id)).toEqual(["junk"]);
  });

  it("keeps a conversation where someone else wrote after the blocked sender", async () => {
    seed("acc1", "reply", 100, ["INBOX"]);
    const add = sqlite.prepare("INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES (?, ?, ?, ?, ?)");
    add.run("m1", "acc1", "reply", "ads@news.com", 90);
    add.run("m2", "acc1", "reply", "friend@x.com", 100);
    sqlite.prepare("INSERT INTO blocked_senders (account_id, address) VALUES (?, ?)").run("acc1", "ads@news.com");

    expect((await getThreads({ labelId: "INBOX" })).map((r) => r.id)).toEqual(["reply"]);
    expect(await getLabelCounts("INBOX")).toEqual({ acc1: 1 });
  });

  it("the Dock counts only the unread threads the inbox list shows", async () => {
    seed("acc1", "unread", 100, ["INBOX"]);
    seed("acc1", "read", 100, ["INBOX"]);
    sqlite.exec("UPDATE threads SET is_read = 1 WHERE id = 'read'");
    seed("acc1", "deal", 100, ["INBOX", "CATEGORY_PROMOTIONS"]);
    seed("acc1", "ads", 100, ["INBOX"]);
    sqlite.prepare("INSERT INTO messages (id, account_id, thread_id, from_address, date) VALUES (?, ?, ?, ?, ?)").run("m1", "acc1", "ads", "ads@news.com", 100);
    sqlite.prepare("INSERT INTO blocked_senders (account_id, address) VALUES (?, ?)").run("acc1", "ads@news.com");
    seed("acc1", "deleted", 100, ["INBOX", "TRASH"]);

    expect((await getThreads({ labelId: "INBOX" })).filter((t) => t.is_read === 0).map((t) => t.id)).toEqual(["unread"]);
    expect(await getUnreadInboxCount()).toBe(1);
  });

  it("keeps a Gmail promotion out of the inbox and its count, and lists it on its own", async () => {
    seed("acc1", "deal", 300, ["INBOX", "CATEGORY_PROMOTIONS"]);
    seed("acc1", "person", 200, ["INBOX"]);
    seed("acc2", "also", 100, ["INBOX", "CATEGORY_PROMOTIONS"]);

    expect((await getThreads({ labelId: "INBOX" })).map((r) => r.id)).toEqual(["person"]);
    expect(await getLabelCounts("INBOX")).toEqual({ acc1: 1 });
    expect((await getPromotionThreads()).map((r) => r.id)).toEqual(["deal", "also"]);
  });

  it("reads the html body when the message has no plain text", async () => {
    seed("acc1", "otp", 100, ["INBOX"]);
    const html = `<style>${"x".repeat(600)}</style><p>Seu código de verificação</p><b>194830</b>`;
    sqlite
      .prepare("INSERT INTO messages (id, account_id, thread_id, date, body_html) VALUES (?, ?, ?, ?, ?)")
      .run("m", "acc1", "otp", 100, html);
    const rows = await getThreads({ labelId: "INBOX" });
    expect(rows[0]?.body_head).toContain("194830");
  });

  it("prefers the plain body over html", async () => {
    seed("acc1", "otp", 100, ["INBOX"]);
    sqlite
      .prepare("INSERT INTO messages (id, account_id, thread_id, date, body_text, body_html) VALUES (?, ?, ?, ?, ?, ?)")
      .run("m", "acc1", "otp", 100, "Seu código de verificação 194830", "<p>999999</p>");
    const rows = await getThreads({ labelId: "INBOX" });
    expect(rows[0]?.body_head).toContain("194830");
    expect(rows[0]?.body_head).not.toContain("999999");
  });

  it("a deleted thread leaves every list", async () => {
    seed("acc1", "gone", 100, ["STARRED", "TRASH"]);
    seed("acc1", "keep", 200, ["STARRED"]);
    expect((await getThreads({ labelId: "STARRED" })).map((r) => r.id)).toEqual(["keep"]);
    expect(await getLabelCounts("STARRED")).toEqual({ acc1: 1 });
  });
});
