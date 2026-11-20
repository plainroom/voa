import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@/services/badgeManager", () => ({
  updateBadgeCount: vi.fn(async () => {}),
}));
const provider = {
  trash: vi.fn(async () => {}),
  addLabel: vi.fn(async () => {}),
  removeLabel: vi.fn(async () => {}),
};
vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(async () => provider),
}));

import { getDb } from "@/services/db/connection";
import { asDb, createInboxDb, seed } from "./inboxDb.test-helper";
import { realSource } from "./source";

let sqlite: DatabaseSync;
const labels = (id: string) =>
  (
    sqlite
      .prepare(
        "SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id",
      )
      .all(id) as { label_id: string }[]
  ).map((r) => r.label_id);

beforeEach(async () => {
  vi.clearAllMocks();
  sqlite = await createInboxDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
});

describe("undo a delete from Starred or Snoozed", () => {
  it("a starred thread that was in the inbox goes back to the inbox", async () => {
    seed(sqlite, "a", "t1", 1, ["INBOX", "STARRED"]);
    const k = { accountId: "a", threadId: "t1" };
    await realSource.trash(k);
    await realSource.untrash(k, null);
    expect(provider.removeLabel).toHaveBeenCalledWith("t1", "TRASH");
    expect(provider.addLabel).toHaveBeenCalledWith("t1", "INBOX");
    expect(labels("t1")).toEqual(["INBOX", "STARRED"]);
  });

  it("a snoozed thread stays out of the inbox", async () => {
    seed(sqlite, "a", "t2", 1, ["SNOOZED"]);
    const k = { accountId: "a", threadId: "t2" };
    await realSource.trash(k);
    await realSource.untrash(k, null);
    expect(provider.removeLabel).toHaveBeenCalledWith("t2", "TRASH");
    expect(provider.addLabel).not.toHaveBeenCalled();
    expect(labels("t2")).toEqual(["SNOOZED"]);
  });
});

describe("undo a delete still in the queue", () => {
  it("drops the queued trash, so the next queue pass cannot delete the thread", async () => {
    seed(sqlite, "a", "t3", 1, ["INBOX", "UNREAD"]);
    provider.trash.mockRejectedValueOnce(new Error("Failed to fetch"));
    const k = { accountId: "a", threadId: "t3" };
    await realSource.trash(k);
    expect(sqlite.prepare("SELECT operation_type, status FROM pending_operations").all()).toEqual([{ operation_type: "trash", status: "pending" }]);
    await realSource.untrash(k, "INBOX");
    expect(sqlite.prepare("SELECT operation_type FROM pending_operations").all()).toEqual([]);
    expect(provider.removeLabel).not.toHaveBeenCalled();
    expect(provider.addLabel).not.toHaveBeenCalled();
    expect(labels("t3")).toEqual(["INBOX", "UNREAD"]);
  });
});
