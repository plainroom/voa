import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphMessage } from "./message";

let sqlite: DatabaseSync;
vi.mock("@tauri-apps/plugin-sql", async () => {
  const { sqliteDb } = await import("../db/schemaDb.test-helper");
  return { default: { load: async () => sqliteDb(() => sqlite) } };
});

const client = vi.hoisted(() => ({
  delta: vi.fn(),
  messages: vi.fn(async (_ids: string[]) => [] as unknown[]),
  flagged: vi.fn(async () => [] as unknown[]),
  search: vi.fn(async () => [] as unknown[]),
  searchPages: vi.fn(async function* (): AsyncGenerator<unknown[]> {}),
  folderId: vi.fn(async (name: string) => `${name}-id`),
  attachments: vi.fn(async () => [] as unknown[]),
  move: vi.fn(async (id: string) => `${id}-moved` as string | null),
  folderMessages: vi.fn(async (_folder: string) => ({ value: [] as GraphMessage[], complete: false })),
}));
vi.mock("./tokenManager", () => ({
  getGraphClient: vi.fn(async () => client),
}));

import { migrate } from "../db/schemaDb.test-helper";
import { recordBlockedMessages } from "../db/blockedSenders";
import { upsertMessage } from "../db/messages";
import { toStoredMessage } from "./message";
import { clearAccountHistoryId } from "../db/accounts";
import { MAX_BODY_TRIES } from "../db/messages";
import { GraphError } from "./client";
import { fetchGraphBodies, restoreGraphSender, syncGraphAccount, syncGraphSearch } from "./sync";

const message: GraphMessage = {
  id: "m1",
  conversationId: "c1",
  subject: "Hello",
  bodyPreview: "Hi",
  receivedDateTime: "2026-11-15T12:00:00Z",
  body: { contentType: "text", content: "Hi" },
  isRead: true,
};

const DELTA = "https://graph/delta?$deltatoken=1";

function account(cursor: string | null = null) {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, email, provider, history_id) VALUES ('acc', 'me@hotmail.com', 'graph', ?)",
    )
    .run(cursor);
}

function seedThread(threadId: string, messageIds: string[], labels: string[]) {
  sqlite
    .prepare(
      "INSERT INTO threads (id, account_id, subject, last_message_at) VALUES (?, 'acc', 'Hello', 1)",
    )
    .run(threadId);
  for (const id of messageIds) {
    sqlite
      .prepare(
        "INSERT INTO messages (id, account_id, thread_id, subject, date, body_text) VALUES (?, 'acc', ?, 'Hello', 1, 'Hi')",
      )
      .run(id, threadId);
  }
  for (const label of labels) {
    sqlite
      .prepare(
        "INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES (?, 'acc', ?)",
      )
      .run(threadId, label);
  }
}

const cursor = () =>
  (
    sqlite
      .prepare("SELECT history_id FROM accounts WHERE id = 'acc'")
      .get() as { history_id: string | null }
  ).history_id;
const passLink = () =>
  (sqlite.prepare("SELECT graph_next_link FROM accounts WHERE id = 'acc'").get() as { graph_next_link: string | null }).graph_next_link;
const labels = (threadId: string) =>
  (
    sqlite
      .prepare(
        "SELECT label_id FROM thread_labels WHERE account_id = 'acc' AND thread_id = ? ORDER BY rowid",
      )
      .all(threadId) as { label_id: string }[]
  ).map((row) => row.label_id);
const stored = () =>
  sqlite
    .prepare(
      "SELECT id, thread_id, is_starred, body_text, body_html FROM messages WHERE account_id = 'acc' ORDER BY id",
    )
    .all() as {
    id: string;
    thread_id: string;
    is_starred: number;
    body_text: string | null;
    body_html: string | null;
  }[];
const threadExists = (threadId: string) =>
  sqlite
    .prepare("SELECT 1 FROM threads WHERE account_id = 'acc' AND id = ?")
    .get(threadId) != null;

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  await migrate();
  for (const fn of Object.values(client)) fn.mockReset();
  client.delta.mockResolvedValue({ value: [message], deltaLink: DELTA });
  client.messages.mockResolvedValue([]);
  client.flagged.mockResolvedValue([]);
  client.attachments.mockResolvedValue([]);
  client.folderId.mockImplementation(async (name: string) => `${name}-id`);
  client.move.mockImplementation(async (id: string) => `${id}-moved`);
  client.folderMessages.mockResolvedValue({ value: [], complete: false });
  // The folders are read once a minute: each test is a minute later.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((now += 120_000));
});
let now = Date.UTC(2026, 10, 15);

describe("Outlook's Deleted Items and Junk", () => {
  const trashed: GraphMessage = { ...message, id: "d1", conversationId: "c9", parentFolderId: "deleteditems-id" };
  const folder = (name: string, value: GraphMessage[], complete = true) =>
    client.folderMessages.mockImplementation(async (f: string) => (f === name ? { value, complete } : { value: [], complete: true }));

  it("mail deleted elsewhere shows in Trash, headers only", async () => {
    account(DELTA);
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    folder("deleteditems", [trashed]);
    await syncGraphAccount("acc");
    expect(labels("c9")).toEqual(["TRASH"]);
    expect(stored().find((m) => m.id === "d1")).toBeDefined();
  });

  it("a conversation still in the inbox stays there when one of its messages is deleted", async () => {
    account(DELTA);
    seedThread("c9", ["m5"], ["INBOX"]);
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    folder("deleteditems", [trashed]);
    await syncGraphAccount("acc");
    expect(labels("c9")).toEqual(["INBOX"]);
  });

  it("when the page is the whole folder, what it no longer has leaves Trash, unless voa's own delete is on the way", async () => {
    account(DELTA);
    seedThread("gone", ["g1"], ["TRASH"]);
    seedThread("mine", ["y1"], ["TRASH"]);
    sqlite
      .prepare("INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status) VALUES ('op', 'acc', 'trash', 'mine', '{}', 'pending')")
      .run();
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    folder("deleteditems", []);
    await syncGraphAccount("acc");
    expect(labels("gone")).toEqual([]);
    expect(labels("mine")).toEqual(["TRASH"]);
  });

  it("junk read elsewhere shows in Spam", async () => {
    account(DELTA);
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    folder("junkemail", [{ ...trashed, parentFolderId: "junkemail-id" }]);
    await syncGraphAccount("acc");
    expect(labels("c9")).toEqual(["SPAM"]);
  });
});

describe("syncGraphAccount", () => {
  it("stores the conversation in the inbox and saves the delta link", async () => {
    account();

    expect(await syncGraphAccount("acc")).toBe(true);

    expect(stored()).toMatchObject([
      { id: "m1", thread_id: "c1", body_text: "Hi" },
    ]);
    expect(labels("c1")).toEqual(["INBOX"]);
    expect(cursor()).toBe(DELTA);
  });

  it("keeps a starred message after it leaves the inbox", async () => {
    account(DELTA);
    seedThread("c1", ["old"], ["INBOX"]);
    client.delta.mockResolvedValue({
      value: [{ id: "old", "@removed": { reason: "changed" } }],
      deltaLink: DELTA,
    });
    client.flagged.mockResolvedValue([
      { ...message, id: "new", flag: { flagStatus: "flagged" } },
    ]);

    await syncGraphAccount("acc");

    expect(stored()).toMatchObject([
      { id: "new", thread_id: "c1", is_starred: 1 },
    ]);
    expect(threadExists("c1")).toBe(true);
    expect(labels("c1")).toEqual(["STARRED"]);
  });

  it("keeps a snoozed message when it leaves the inbox", async () => {
    account(DELTA);
    seedThread("c1", ["old"], ["INBOX", "SNOOZED"]);
    client.delta.mockResolvedValue({
      value: [{ id: "old", "@removed": { reason: "changed" } }],
      deltaLink: DELTA,
    });

    await syncGraphAccount("acc");

    expect(stored().map((row) => row.id)).toEqual(["old"]);
    expect(labels("c1")).toEqual(["SNOOZED"]);
  });

  it("keeps a blocked message when it leaves the inbox", async () => {
    account(DELTA);
    seedThread("c1", ["old"], ["INBOX", "BLOCKED"]);
    client.delta.mockResolvedValue({
      value: [{ id: "old", "@removed": { reason: "changed" } }],
      deltaLink: DELTA,
    });

    await syncGraphAccount("acc");

    expect(stored().map((row) => row.id)).toEqual(["old"]);
    expect(labels("c1")).toEqual(["BLOCKED"]);
  });

  it("drops a conversation that left the inbox and nothing else keeps", async () => {
    account(DELTA);
    seedThread("c1", ["old"], ["INBOX"]);
    client.delta.mockResolvedValue({
      value: [{ id: "old", "@removed": { reason: "changed" } }],
      deltaLink: DELTA,
    });

    await syncGraphAccount("acc");

    expect(stored()).toEqual([]);
    expect(threadExists("c1")).toBe(false);
  });

  it("keeps spam when a flagged message is stored outside the inbox", async () => {
    account(DELTA);
    seedThread("c1", ["m0"], ["SPAM"]);
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    client.flagged.mockResolvedValue([
      { ...message, flag: { flagStatus: "flagged" } },
    ]);

    await syncGraphAccount("acc");

    expect(labels("c1")).toEqual(["STARRED", "SPAM"]);
  });

  it("stores a file attachment on the message", async () => {
    account();
    client.delta.mockResolvedValue({
      value: [{ ...message, hasAttachments: true }],
      deltaLink: DELTA,
    });
    client.attachments.mockResolvedValue([
      {
        id: "file-1",
        name: "a.pdf",
        contentType: "application/pdf",
        size: 4,
        isInline: false,
      },
    ]);

    await syncGraphAccount("acc");

    expect(
      sqlite
        .prepare(
          "SELECT id, message_id, gmail_attachment_id, filename FROM attachments",
        )
        .all(),
    ).toEqual([
      {
        id: "m1:file-1",
        message_id: "m1",
        gmail_attachment_id: "file-1",
        filename: "a.pdf",
      },
    ]);
  });

  it("stores a message whose body Microsoft did not give without one, and fills it at a later run", async () => {
    account();
    client.delta.mockResolvedValue({ value: [{ ...message, body: undefined }], deltaLink: DELTA });
    client.messages.mockResolvedValue([]);

    await syncGraphAccount("acc");
    expect(stored()).toMatchObject([{ id: "m1", body_text: null, body_html: null }]);

    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    client.messages.mockResolvedValue([{ ...message, body: { contentType: "html", content: "<p>Hi</p>" } }]);
    expect(await syncGraphAccount("acc")).toBe(true);

    expect(client.messages).toHaveBeenLastCalledWith(["m1"], expect.any(Set));
    expect(stored()).toMatchObject([{ id: "m1", body_html: "<p>Hi</p>", body_text: null }]);
  });

  it("a failed body fetch for an old message never fails the run", async () => {
    account(DELTA);
    seedThread("c1", ["old"], ["INBOX"]);
    sqlite.prepare("UPDATE messages SET body_text = NULL").run();
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    client.messages.mockRejectedValue(new Error("Graph 500"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(syncGraphAccount("acc")).resolves.toBe(false);
    warn.mockRestore();
  });

  describe("bodies asked for again", () => {
    const bodyless = (ids: string[]) => {
      seedThread("c1", ids, ["INBOX"]);
      sqlite.prepare("UPDATE messages SET body_text = NULL").run();
    };
    const row = (id: string) =>
      sqlite.prepare("SELECT body_tries, body_unavailable, body_text FROM messages WHERE id = ?").get(id) as {
        body_tries: number;
        body_unavailable: number;
        body_text: string | null;
      };

    beforeEach(() => client.delta.mockResolvedValue({ value: [], deltaLink: DELTA }));

    it("gives up at once on a body Microsoft no longer has (404), and never asks again", async () => {
      account(DELTA);
      bodyless(["gone"]);
      client.messages.mockImplementation(async (_ids: string[], gone?: Set<string>) => {
        gone?.add("gone");
        return [];
      });

      expect(await syncGraphAccount("acc")).toBe(true);
      expect(row("gone")).toMatchObject({ body_unavailable: 1, body_text: null });

      client.messages.mockClear();
      await syncGraphAccount("acc");
      expect(client.messages).not.toHaveBeenCalled();
    });

    it("asks the least tried first, so a body that never comes does not starve the others, and stops after the bound", async () => {
      account(DELTA);
      bodyless(["stuck", "waiting"]);
      sqlite.prepare("UPDATE messages SET date = 2 WHERE id = 'stuck'").run();
      const asked: string[][] = [];
      client.messages.mockImplementation(async (ids: string[]) => {
        asked.push(ids);
        return [];
      });
      const runs = MAX_BODY_TRIES + 2;
      for (let run = 0; run < runs; run++) await syncGraphAccount("acc");

      expect(asked[0]).toEqual(["stuck", "waiting"]);
      expect(asked).toHaveLength(MAX_BODY_TRIES);
      expect(row("stuck")).toMatchObject({ body_tries: MAX_BODY_TRIES, body_unavailable: 1 });
      expect(row("waiting")).toMatchObject({ body_tries: MAX_BODY_TRIES, body_unavailable: 1 });
    });

    it("a body that comes later is stored and no longer unavailable", async () => {
      account(DELTA);
      bodyless(["late"]);
      client.messages.mockResolvedValue([{ ...message, id: "late", body: { contentType: "text", content: "At last" } }]);

      await syncGraphAccount("acc");

      expect(row("late")).toMatchObject({ body_text: "At last", body_unavailable: 0 });
    });
  });

  it("a resync in the middle of a pass starts it again from the first page", async () => {
    account();
    seedThread("seen", ["s1"], ["INBOX"]);
    sqlite.prepare("UPDATE accounts SET graph_next_link = 'https://graph/delta?$skiptoken=7' WHERE id = 'acc'").run();
    sqlite.prepare("INSERT INTO graph_pass_seen (account_id, thread_id) VALUES ('acc', 'seen')").run();

    await clearAccountHistoryId("acc");
    expect(passLink()).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM graph_pass_seen").get()).toEqual({ n: 0 });

    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });
    await syncGraphAccount("acc");
    expect(client.delta.mock.calls[0]).toEqual([undefined]);
  });

  describe("paging", () => {
    it("a first sync saves each page's next link apart, counting as syncing, and a run cut short goes on from there", async () => {
      account();
      client.delta
        .mockResolvedValueOnce({ value: [message], nextLink: "https://graph/delta?$skiptoken=1" })
        .mockRejectedValueOnce(new Error("offline"));

      await expect(syncGraphAccount("acc")).rejects.toThrow("offline");
      expect(stored().map((row) => row.id)).toEqual(["m1"]);
      expect(cursor()).toBeNull();
      expect(passLink()).toBe("https://graph/delta?$skiptoken=1");

      client.delta.mockResolvedValueOnce({ value: [{ ...message, id: "m2", conversationId: "c2" }], deltaLink: DELTA });
      await syncGraphAccount("acc");

      expect(client.delta).toHaveBeenLastCalledWith("https://graph/delta?$skiptoken=1");
      expect(stored().map((row) => row.id)).toEqual(["m1", "m2"]);
      expect(labels("c1")).toEqual(["INBOX"]);
      expect(labels("c2")).toEqual(["INBOX"]);
      expect(cursor()).toBe(DELTA);
      expect(passLink()).toBeNull();
    });

    it("stops a large inbox at the page limit without an error, still syncing, and the next run resumes", async () => {
      account();
      let page = 0;
      client.delta.mockImplementation(async () => {
        page++;
        return { value: [{ ...message, id: `m${page}`, conversationId: `c${page}` }], nextLink: `https://graph/delta?$skiptoken=${page}` };
      });

      await syncGraphAccount("acc");
      const calls = client.delta.mock.calls.length;
      expect(cursor()).toBeNull();
      expect(passLink()).toBe(`https://graph/delta?$skiptoken=${calls}`);

      await syncGraphAccount("acc");
      expect(client.delta.mock.calls[calls]).toEqual([`https://graph/delta?$skiptoken=${calls}`]);
    });

    it("a long catch-up from a delta link keeps its next links as the cursor: the account stays synced", async () => {
      account(DELTA);
      client.delta
        .mockResolvedValueOnce({ value: [message], nextLink: "https://graph/delta?$skiptoken=9" })
        .mockRejectedValueOnce(new Error("offline"));

      await expect(syncGraphAccount("acc")).rejects.toThrow("offline");

      expect(cursor()).toBe("https://graph/delta?$skiptoken=9");
      expect(passLink()).toBeNull();
    });
  });

  describe("the end of a full pass", () => {
    it("takes out of the local inbox the threads the pass did not see there, and only those", async () => {
      account("https://graph/delta?$deltatoken=old");
      seedThread("gone", ["g1"], ["INBOX"]);
      seedThread("kept", ["m1"], ["INBOX"]);
      seedThread("snoozed", ["s1"], ["SNOOZED"]);
      seedThread("starred", ["f1"], ["INBOX", "STARRED"]);
      client.delta
        .mockRejectedValueOnce(new GraphError(410, "syncStateNotFound", "Microsoft Graph GET failed (410)"))
        .mockResolvedValueOnce({ value: [{ ...message, conversationId: "kept" }], nextLink: "https://graph/delta?$skiptoken=1" })
        .mockResolvedValueOnce({ value: [{ ...message, id: "m2", conversationId: "new" }], deltaLink: DELTA });

      await syncGraphAccount("acc");

      expect(labels("gone")).toEqual([]);
      expect(labels("starred")).toEqual(["STARRED"]);
      expect(labels("snoozed")).toEqual(["SNOOZED"]);
      expect(labels("kept")).toEqual(["INBOX"]);
      expect(labels("new")).toEqual(["INBOX"]);
      expect(client.move).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT count(*) AS n FROM graph_pass_seen").get()).toEqual({ n: 0 });
    });

    it("remembers what it saw across runs", async () => {
      account();
      seedThread("gone", ["g1"], ["INBOX"]);
      client.delta.mockResolvedValueOnce({ value: [{ ...message, conversationId: "early" }], nextLink: "https://graph/delta?$skiptoken=1" });
      client.delta.mockRejectedValueOnce(new Error("offline"));
      await expect(syncGraphAccount("acc")).rejects.toThrow("offline");
      expect(labels("gone")).toEqual(["INBOX"]);

      client.delta.mockResolvedValueOnce({ value: [], deltaLink: DELTA });
      await syncGraphAccount("acc");

      expect(labels("early")).toEqual(["INBOX"]);
      expect(labels("gone")).toEqual([]);
    });

    it("an ordinary delta run takes nothing out of the inbox", async () => {
      account(DELTA);
      seedThread("old", ["o1"], ["INBOX"]);
      client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });

      await syncGraphAccount("acc");

      expect(labels("old")).toEqual(["INBOX"]);
    });
  });

  describe("an expired cursor", () => {
    it("is dropped and the inbox read again from the start, in the same run", async () => {
      account("https://graph/delta?$deltatoken=old");
      client.delta
        .mockRejectedValueOnce(
          new GraphError(
            410,
            "syncStateNotFound",
            "Microsoft Graph GET failed (410)",
          ),
        )
        .mockResolvedValueOnce({ value: [message], deltaLink: DELTA });

      expect(await syncGraphAccount("acc")).toBe(true);

      expect(client.delta.mock.calls).toEqual([
        ["https://graph/delta?$deltatoken=old"],
        [undefined],
      ]);
      expect(cursor()).toBe(DELTA);
      expect(stored().map((row) => row.id)).toEqual(["m1"]);
    });

    it("resets on resyncRequired too, whatever the status", async () => {
      account("https://graph/delta?$skiptoken=old");
      client.delta
        .mockRejectedValueOnce(
          new GraphError(
            400,
            "resyncRequired",
            "Microsoft Graph GET failed (400)",
          ),
        )
        .mockResolvedValueOnce({ value: [], deltaLink: DELTA });

      await syncGraphAccount("acc");

      expect(cursor()).toBe(DELTA);
    });

    it("starts over only once a run: a fresh read that fails is the run's error", async () => {
      account("https://graph/delta?$deltatoken=old");
      client.delta.mockRejectedValue(
        new GraphError(410, undefined, "Microsoft Graph GET failed (410)"),
      );

      await expect(syncGraphAccount("acc")).rejects.toThrow("410");

      expect(client.delta).toHaveBeenCalledTimes(2);
      expect(cursor()).toBeNull();
    });

    it("keeps the cursor on any other error", async () => {
      account(DELTA);
      client.delta.mockRejectedValue(
        new GraphError(500, undefined, "Microsoft Graph GET failed (500)"),
      );

      await expect(syncGraphAccount("acc")).rejects.toThrow("500");

      expect(cursor()).toBe(DELTA);
    });
  });
});

describe("syncGraphSearch", () => {
  const headersOnly = { id: "m9", conversationId: "c1", subject: "Hello", bodyPreview: "Hi", receivedDateTime: "2026-11-15T12:00:00Z" };
  const pending = () =>
    (sqlite.prepare("SELECT id, body_pending FROM messages WHERE account_id = 'acc' ORDER BY id").all() as { id: string; body_pending: number }[]).map(
      (row) => [row.id, row.body_pending],
    );

  it("stores a search hit that is not in the inbox yet, outside the inbox, leaving the cursor", async () => {
    account(DELTA);
    client.search.mockResolvedValue([{ ...headersOnly, parentFolderId: "other" }]);

    await syncGraphSearch("acc", "hiago");

    expect(stored()).toMatchObject([{ id: "m9", thread_id: "c1" }]);
    expect(labels("c1")).toEqual([]);
    expect(cursor()).toBe(DELTA);
  });

  it("stores the hit with its headers only, marked to fetch its body when opened, and asks for no body", async () => {
    account(DELTA);
    client.search.mockResolvedValue([{ ...headersOnly, parentFolderId: "inbox-id" }]);

    await syncGraphSearch("acc", "hiago");

    expect(stored()).toMatchObject([{ id: "m9", body_text: null, body_html: null }]);
    expect(pending()).toEqual([["m9", 1]]);
    expect(client.messages).not.toHaveBeenCalled();
    expect(labels("c1")).toEqual(["INBOX"]);
  });

  it("keeps what is stored: only the messages not on disk are added, and the conversation's labels stay", async () => {
    account(DELTA);
    seedThread("c1", ["m1"], ["TRASH"]);
    sqlite.prepare("UPDATE messages SET to_addresses = 'me@hotmail.com', reply_to = 'r@x.com' WHERE id = 'm1'").run();
    client.search.mockResolvedValue([
      { ...headersOnly, id: "m1", parentFolderId: "inbox-id" },
      { ...headersOnly, id: "m2", parentFolderId: "inbox-id" },
    ]);

    await syncGraphSearch("acc", "hiago");

    expect(sqlite.prepare("SELECT to_addresses, reply_to, body_text FROM messages WHERE id = 'm1'").get()).toEqual({
      to_addresses: "me@hotmail.com",
      reply_to: "r@x.com",
      body_text: "Hi",
    });
    expect(pending()).toEqual([
      ["m1", 0],
      ["m2", 1],
    ]);
    expect(labels("c1")).toEqual(["TRASH"]);
  });

  it("a headers-only row never erases a stored field", async () => {
    account(DELTA);
    seedThread("c1", ["m1"], []);
    sqlite.prepare("UPDATE messages SET to_addresses = 'me@hotmail.com', list_unsubscribe = '<mailto:u@x.com>' WHERE id = 'm1'").run();

    await upsertMessage({ ...toStoredMessage("acc", { ...headersOnly, id: "m1" }), bodyPending: true });

    expect(sqlite.prepare("SELECT to_addresses, list_unsubscribe, body_text FROM messages WHERE id = 'm1'").get()).toEqual({
      to_addresses: "me@hotmail.com",
      list_unsubscribe: "<mailto:u@x.com>",
      body_text: "Hi",
    });
    expect(pending()).toEqual([["m1", 0]]);
  });

  it("an aborted search stores nothing", async () => {
    account(DELTA);
    client.search.mockResolvedValue([headersOnly]);
    const controller = new AbortController();
    controller.abort();

    await syncGraphSearch("acc", "hiago", controller.signal);

    expect(stored()).toEqual([]);
  });

  it("opening the conversation fetches the bodies, and the rows no longer wait, even one Microsoft gave empty", async () => {
    account(DELTA);
    client.search.mockResolvedValue([headersOnly, { ...headersOnly, id: "m8" }]);
    await syncGraphSearch("acc", "hiago");
    client.messages.mockResolvedValue([
      { ...message, id: "m9", body: { contentType: "html", content: "<p>Hi</p>" }, toRecipients: [{ emailAddress: { address: "me@hotmail.com" } }] },
      { ...message, id: "m8", body: { contentType: "text", content: "" } },
    ]);

    await fetchGraphBodies("acc", ["m8", "m9"]);

    expect(client.messages).toHaveBeenCalledWith(["m8", "m9"], expect.any(Set));
    expect(stored()).toMatchObject([
      { id: "m8", body_text: "" },
      { id: "m9", body_html: "<p>Hi</p>" },
    ]);
    expect(pending()).toEqual([
      ["m8", 0],
      ["m9", 0],
    ]);
    expect(sqlite.prepare("SELECT to_addresses FROM messages WHERE id = 'm9'").get()).toMatchObject({ to_addresses: expect.stringContaining("me@hotmail.com") });
  });

  it("a search hit Microsoft no longer has when it is opened stops waiting and shows as unavailable", async () => {
    account(DELTA);
    client.search.mockResolvedValue([headersOnly]);
    await syncGraphSearch("acc", "hiago");
    client.messages.mockImplementation(async (ids: string[], gone?: Set<string>) => {
      for (const id of ids) gone?.add(id);
      return [];
    });

    await fetchGraphBodies("acc", ["m9"]);

    expect(sqlite.prepare("SELECT body_pending, body_unavailable FROM messages WHERE id = 'm9'").get()).toEqual({ body_pending: 0, body_unavailable: 1 });
  });

  it("the regular sync leaves a headers-only hit alone: its body costs a request only when it is opened", async () => {
    account(DELTA);
    client.search.mockResolvedValue([headersOnly]);
    await syncGraphSearch("acc", "hiago");
    client.delta.mockResolvedValue({ value: [], deltaLink: DELTA });

    await syncGraphAccount("acc");

    expect(client.messages).not.toHaveBeenCalled();
  });

  it("a body Microsoft does not answer keeps the row waiting", async () => {
    account(DELTA);
    client.search.mockResolvedValue([headersOnly]);
    await syncGraphSearch("acc", "hiago");

    await fetchGraphBodies("acc", ["m9"]);

    expect(pending()).toEqual([["m9", 1]]);
  });
});

describe("restoreGraphSender", () => {
  const pages = (list: unknown[][]) =>
    client.searchPages.mockImplementation(async function* () {
      for (const page of list) yield page;
    });

  beforeEach(() => account(DELTA));

  it("returns only the messages the block archived, never mail archived by hand", async () => {
    await recordBlockedMessages("acc", "ads@news.com", ["<blocked@x>"]);
    pages([
      [
        {
          ...message,
          id: "b1",
          internetMessageId: "<blocked@x>",
          parentFolderId: "archive-id",
        },
        {
          ...message,
          id: "h1",
          conversationId: "c2",
          internetMessageId: "<by-hand@x>",
          parentFolderId: "archive-id",
        },
        {
          ...message,
          id: "h2",
          conversationId: "c3",
          parentFolderId: "archive-id",
        },
      ],
    ]);

    expect(await restoreGraphSender("acc", "ads@news.com")).toEqual([
      "<blocked@x>",
    ]);

    expect(client.move.mock.calls).toEqual([["b1", "inbox"]]);
    expect(stored().map((row) => row.id)).toEqual(["b1-moved"]);
    expect(labels("c1")).toEqual(["INBOX"]);
  });

  it("asks Microsoft nothing when the block archived nothing", async () => {
    await restoreGraphSender("acc", "ads@news.com");

    expect(client.searchPages).not.toHaveBeenCalled();
    expect(client.move).not.toHaveBeenCalled();
  });

  it("reads every page, and returns only the Message-IDs it moved back", async () => {
    await recordBlockedMessages("acc", "ads@news.com", [
      "<p1@x>",
      "<p2@x>",
      "<fails@x>",
      "<missing@x>",
    ]);
    client.move.mockImplementation(async (id: string) => {
      if (id === "f1") throw new Error("Graph 503");
      return `${id}-moved`;
    });
    pages([
      [
        {
          ...message,
          id: "p1",
          internetMessageId: "<p1@x>",
          parentFolderId: "archive-id",
        },
        {
          ...message,
          id: "f1",
          internetMessageId: "<fails@x>",
          parentFolderId: "archive-id",
        },
      ],
      [
        {
          ...message,
          id: "p2",
          internetMessageId: "<p2@x>",
          parentFolderId: "archive-id",
        },
      ],
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const restored = await restoreGraphSender("acc", "ads@news.com");
    error.mockRestore();

    expect(client.move.mock.calls.map(([id]) => id)).toEqual([
      "p1",
      "f1",
      "p2",
    ]);
    expect(restored.sort()).toEqual(["<p1@x>", "<p2@x>"]);
  });
});
