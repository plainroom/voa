import type { DatabaseSync } from "node:sqlite";

let sqlite: DatabaseSync;
vi.mock("./connection", async () => {
  const { asDb } = await import("@/voa/inbox/inboxDb.test-helper");
  return { getDb: async () => asDb(sqlite) };
});

import { getOwnAddresses, setSendAsAliases } from "./sendAsAliases";

beforeEach(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE send_as_aliases (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, email TEXT NOT NULL, UNIQUE(account_id, email))");
});

describe("send-as aliases", () => {
  it("the owner is the account and every alias Gmail listed, replaced on each read", async () => {
    await setSendAsAliases("a", ["Me@Home.com", "old@alias.com"]);
    await setSendAsAliases("a", ["Me@Home.com", "Work@Alias.com", "work@alias.com"]);
    await setSendAsAliases("b", ["other@x.com"]);
    expect(await getOwnAddresses("a", "ME@home.com")).toEqual(new Set(["me@home.com", "work@alias.com"]));
  });
});
