import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@/services/badgeManager", () => ({
  updateBadgeCount: vi.fn(async () => {}),
}));
const provider = {
  archive: vi.fn(async (_threadId: string, _ids: string[]) => {}),
  trash: vi.fn(async (_threadId: string, _ids: string[]) => {}),
};
vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(async () => provider),
}));

import { getDb } from "@/services/db/connection";
import {
  getPendingOpsForResource,
  recoverInterruptedOperations,
} from "@/services/db/pendingOperations";
import { asDb, createInboxDb, seed } from "@/voa/inbox/inboxDb.test-helper";
import { archiveThreads, trashThreads } from "./emailActions";

let sqlite: DatabaseSync;
const labels = (id: string) =>
  (
    sqlite
      .prepare(
        "SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id",
      )
      .all(id) as { label_id: string }[]
  ).map((r) => r.label_id);
const ops = () =>
  sqlite
    .prepare(
      "SELECT resource_id, operation_type, status FROM pending_operations ORDER BY resource_id",
    )
    .all() as {
    resource_id: string;
    operation_type: string;
    status: string;
  }[];
const item = (threadId: string) => ({
  accountId: "a",
  threadId,
  messageIds: [`m-a-${threadId}`],
});

beforeEach(async () => {
  vi.clearAllMocks();
  sqlite = await createInboxDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
  seed(sqlite, "a", "t1", 1, ["INBOX"]);
  seed(sqlite, "a", "t2", 2, ["INBOX", "STARRED"]);
});

describe("archiveThreads", () => {
  it("takes every thread out of the inbox and holds it before the first call, then drops the hold", async () => {
    provider.archive.mockImplementationOnce(async () => {
      expect(labels("t1")).toEqual([]);
      expect(labels("t2")).toEqual(["STARRED"]);
      expect(ops().map((op) => op.status)).toEqual(["executing", "executing"]);
    });
    expect(await archiveThreads([item("t1"), item("t2")])).toEqual({
      success: true,
    });
    expect(provider.archive.mock.calls).toEqual([
      ["t1", ["m-a-t1"]],
      ["t2", ["m-a-t2"]],
    ]);
    expect(ops()).toEqual([]);
  });

  it("keeps a thread whose call failed for the network in the queue, and puts back one Gmail refused", async () => {
    provider.archive
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("Invalid label"));
    expect(await archiveThreads([item("t1"), item("t2")])).toEqual({
      success: true,
    });
    expect(ops()).toEqual([
      { resource_id: "t1", operation_type: "archive", status: "pending" },
    ]);
    expect(labels("t2")).toEqual(["INBOX", "STARRED"]);
  });
});

describe("trashThreads", () => {
  it("trashes every thread and says so only when one went through", async () => {
    expect(await trashThreads([item("t1"), item("t2")])).toEqual({
      success: true,
    });
    expect(labels("t1")).toEqual(["TRASH"]);
    expect(labels("t2")).toEqual(["STARRED", "TRASH"]);
    expect(ops()).toEqual([]);
  });

  it("puts every label back on a permanent failure and reports it", async () => {
    provider.trash.mockRejectedValue(new Error("Not found"));
    expect(await trashThreads([item("t1"), item("t2")])).toEqual({
      success: false,
      error: "Couldn't delete",
    });
    expect(labels("t1")).toEqual(["INBOX"]);
    expect(labels("t2")).toEqual(["INBOX", "STARRED"]);
    provider.trash.mockReset();
  });
});

describe("a batch the app quit in the middle of", () => {
  it("goes back to the queue as pending, still holding its threads from sync until it runs", async () => {
    provider.archive.mockImplementation(() => new Promise(() => {})); // the quit: Gmail never answers
    void archiveThreads([item("t1"), item("t2")]);
    await vi.waitFor(() =>
      expect(ops().map((op) => op.status)).toEqual(["executing", "executing"]),
    );
    provider.archive.mockReset();

    // The next run: these rows are older than it.
    await recoverInterruptedOperations(Math.floor(Date.now() / 1000) + 1);
    expect(ops().map((op) => op.status)).toEqual(["pending", "pending"]);
    expect(await getPendingOpsForResource("a", "t1")).toHaveLength(1);
  });

  it("never touches an operation this run has in flight", async () => {
    sqlite.exec(
      `INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
       VALUES ('now', 'a', 'archive', 't1', '{}', 'executing', 1000)`,
    );
    await recoverInterruptedOperations(1000);
    expect(ops()[0]?.status).toBe("executing");
  });

  it("does not send a message again by itself: it may have gone out", async () => {
    sqlite.exec(
      `INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
       VALUES ('s', 'a', 'sendMessage', 'x', '{}', 'executing', 10)`,
    );
    await recoverInterruptedOperations(1000);
    expect(ops()).toEqual([
      { resource_id: "x", operation_type: "sendMessage", status: "uncertain" },
    ]);
  });
});
