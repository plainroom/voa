import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));

import { getDb } from "@/services/db/connection";
import { asDb, createInboxDb, seed } from "@/voa/inbox/inboxDb.test-helper";
import { getThreads } from "./threads";

let sqlite: DatabaseSync;
const html = "<p>Your code is 123456</p>";

function thread(id: string, read: 0 | 1, bodyText: string | null) {
  seed(sqlite, "a", id, 1, ["INBOX"]);
  sqlite.prepare("UPDATE threads SET is_read = ? WHERE id = ?").run(read, id);
  sqlite.prepare("UPDATE messages SET body_text = ?, body_html = ? WHERE thread_id = ?").run(bodyText, html, id);
}

beforeEach(async () => {
  sqlite = await createInboxDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
});

describe("getThreads body_head", () => {
  it("uses the text part when there is one", async () => {
    thread("t1", 0, "plain text");
    expect((await getThreads({ labelId: "INBOX" }))[0].body_head).toBe("plain text");
  });

  it("reads the HTML head of an unread thread only", async () => {
    thread("unread", 0, null);
    thread("read", 1, null);
    const byId = Object.fromEntries((await getThreads({ labelId: "INBOX" })).map((t) => [t.id, t.body_head]));
    expect(byId.unread).toBe(html);
    expect(byId.read).toBeNull();
  });
});
