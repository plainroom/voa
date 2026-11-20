import { renderHook, act, waitFor } from "@testing-library/react";
import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
const provider = { archive: vi.fn(), star: vi.fn(), addLabel: vi.fn(), removeLabel: vi.fn(), trash: vi.fn() };
vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(async () => provider),
}));
vi.mock("@/services/emailActions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/emailActions")>();
  return {
    ...actual,
    archiveThread: vi.fn(actual.archiveThread),
    starThread: vi.fn(actual.starThread),
    unarchiveThread: vi.fn(actual.unarchiveThread),
  };
});

import { getDb } from "@/services/db/connection";
import { getEmailProvider } from "@/services/email/providerFactory";
import { archiveThread, starThread } from "@/services/emailActions";
import { useUIStore } from "@/stores/uiStore";
import { useToastStore } from "../ui/Toast";
import { useVoaStore } from "@/stores/list";
import { getPendingOpsForResource } from "@/services/db/pendingOperations";
import { forgetReads, useInbox } from "./useInbox";
import { asDb, createInboxDb, seed as seedRow } from "./inboxDb.test-helper";

let sqlite: DatabaseSync;
const seed = (accountId: string, id: string, at: number, labels: string[]) => seedRow(sqlite, accountId, id, at, labels);

const labelsOf = (accountId: string, threadId: string) =>
  (
    sqlite
      .prepare(
        "SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id",
      )
      .all(accountId, threadId) as { label_id: string }[]
  ).map((r) => r.label_id);

beforeEach(async () => {
  vi.clearAllMocks();
  forgetReads();
  sqlite = await createInboxDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
  useUIStore.setState({ isOnline: true });
  useToastStore.setState({ current: null, lastUndo: null });
  useVoaStore.setState({ filter: null, selected: null, list: "INBOX", pile: "mail", hidden: new Set() });
});

async function loaded(list: "INBOX" | "STARRED" | "SPAM" | "TRASH" = "INBOX") {
  const hook = renderHook(() => useInbox(list));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

const ids = (rows: { account_id: string; id: string }[]) =>
  rows.map((r) => `${r.account_id}:${r.id}`);

describe("useInbox", () => {
  it("a list opened again shows its last read at once, the row just done still out", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    const first = await loaded();
    first.result.current.done({ accountId: "a", threadId: "t1" });
    first.unmount();

    // Leaving the conversation mounts the list again: no empty frame while it reads, and zero already.
    const again = renderHook(() => useInbox("INBOX"));
    expect(again.result.current.loading).toBe(false);
    expect(again.result.current.rows).toEqual([]);
    expect(again.result.current.counts).toEqual({ a: 0 });
  });

  it("a done from the reader never shows the row again on the list it returns to", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    const reader = await loaded();
    const shown: string[][] = [];
    renderHook(() => {
      const list = useInbox("INBOX");
      shown.push(ids(list.rows));
      return list;
    });

    await act(() => reader.result.current.done({ accountId: "a", threadId: "t1" }));
    await waitFor(() => expect(shown.at(-1)).toEqual([]));
    expect(shown.slice(shown.findIndex((rows) => rows.length === 0))).not.toContainEqual(["a:t1"]);
  });

  it("a read that started before a newer one never replaces it", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    const { result } = await loaded();
    // The older read sees the database as it was before the write; the newer one, after it.
    const before = await createInboxDb();
    seedRow(before, "a", "t1", 100, ["INBOX"]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.mocked(getDb).mockImplementation(async () => {
      await held;
      return asDb(before);
    });
    const older = result.current.reload();
    vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
    sqlite.prepare("DELETE FROM thread_labels WHERE thread_id = 't1'").run();
    await act(() => result.current.reload());
    expect(ids(result.current.rows)).toEqual([]);

    release();
    await act(() => older);
    expect(ids(result.current.rows)).toEqual([]);
  });

  it("done archives through emailActions and removes the row; undo restores it", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    seed("a", "t2", 200, ["INBOX"]);
    const { result } = await loaded();
    expect(ids(result.current.rows)).toEqual(["a:t2", "a:t1"]);

    await act(() => result.current.done({ accountId: "a", threadId: "t1" }));
    expect(archiveThread).toHaveBeenCalledWith("a", "t1", ["m-a-t1"]);
    expect(provider.archive).toHaveBeenCalledWith("t1", ["m-a-t1"]);
    expect(ids(result.current.rows)).toEqual(["a:t2"]);
    expect(useToastStore.getState().current?.message).toBe("Done");

    await act(() => result.current.undoLast());
    await waitFor(() =>
      expect(ids(result.current.rows)).toEqual(["a:t2", "a:t1"]),
    );
    expect(provider.addLabel).toHaveBeenCalledWith("t1", "INBOX");
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
  });

  it("done is optimistic: the toast shows before the provider answers, and Undo waits for it", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    let answer!: () => void;
    provider.archive.mockImplementationOnce(() => new Promise<void>((resolve) => (answer = resolve)));
    const { result } = await loaded();

    let landed!: Promise<void>;
    act(() => {
      landed = result.current.done({ accountId: "a", threadId: "t1" });
    });
    expect(ids(result.current.rows)).toEqual([]);
    expect(useToastStore.getState().current?.message).toBe("Done");
    await waitFor(() => expect(provider.archive).toHaveBeenCalled());

    const undone = useToastStore.getState().undoLast();
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.addLabel).not.toHaveBeenCalled();

    answer();
    await act(async () => {
      await landed;
      await undone;
    });
    expect(provider.addLabel).toHaveBeenCalledWith("t1", "INBOX");
    await waitFor(() => expect(ids(result.current.rows)).toEqual(["a:t1"]));
  });

  it("an exit from a screen that closed before the write landed does not bring the row back to the list", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    let answer!: () => void;
    provider.archive.mockImplementationOnce(() => new Promise<void>((resolve) => (answer = resolve)));
    const list = await loaded();
    const reader = await loaded();

    let landed!: Promise<void>;
    act(() => {
      landed = reader.result.current.done({ accountId: "a", threadId: "t1" });
    });
    reader.unmount();
    expect(ids(list.result.current.rows)).toEqual([]);
    await waitFor(() => expect(provider.archive).toHaveBeenCalled());

    answer();
    await act(() => landed);
    expect(ids(list.result.current.rows)).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(ids(list.result.current.rows)).toEqual([]);
  });

  it("a deleted conversation shows in Trash once the delete lands", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    const inbox = await loaded();
    await act(() => inbox.result.current.remove([{ accountId: "a", threadId: "t1" }]));
    inbox.unmount();
    const { result } = await loaded("TRASH");
    expect(ids(result.current.rows)).toEqual(["a:t1"]);
  });

  it("Trash lists every account's deleted mail, and moving one to the inbox takes it out", async () => {
    seed("a", "t1", 100, ["TRASH"]);
    seed("b", "t2", 200, ["INBOX", "TRASH"]);
    seed("a", "t3", 300, ["INBOX"]);
    const { result } = await loaded("TRASH");
    expect(ids(result.current.rows)).toEqual(["b:t2", "a:t1"]);

    await act(() => result.current.restore({ accountId: "a", threadId: "t1" }));
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(useToastStore.getState().current?.message).toBe("Moved to Inbox");
    await waitFor(() => expect(ids(result.current.rows)).toEqual(["b:t2"]));
  });

  it("a done that fails for good puts the row back, in the database too, and says so", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    provider.archive.mockRejectedValueOnce(new Error("Gmail API error: 404 Not Found"));
    const { result } = await loaded();

    await act(() => result.current.done({ accountId: "a", threadId: "t1" }));
    expect(ids(result.current.rows)).toEqual(["a:t1"]);
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(useToastStore.getState().current?.message).toBe("Couldn't archive");
    expect(useToastStore.getState().lastUndo).toBeNull();
  });

  it("a star that fails for good puts the row back unstarred and says so", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    provider.star.mockRejectedValueOnce(new Error("Gmail API error: 400 Bad Request"));
    const { result } = await loaded();

    await act(() => result.current.star({ accountId: "a", threadId: "t1" }));
    expect(ids(result.current.rows)).toEqual(["a:t1"]);
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(useToastStore.getState().current?.message).toBe("Couldn't star");
  });

  it("a star whose archive fails for good is unstarred again", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    provider.archive.mockRejectedValueOnce(new Error("Gmail API error: 404 Not Found"));
    const { result } = await loaded();

    await act(() => result.current.star({ accountId: "a", threadId: "t1" }));
    expect(ids(result.current.rows)).toEqual(["a:t1"]);
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(useToastStore.getState().current?.message).toBe("Couldn't star");
  });

  it("star stars and archives", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    const { result } = await loaded();

    await act(() => result.current.star({ accountId: "a", threadId: "t1" }));
    expect(starThread).toHaveBeenCalledWith("a", "t1", ["m-a-t1"], true);
    expect(archiveThread).toHaveBeenCalledWith("a", "t1", ["m-a-t1"]);
    expect(result.current.rows).toEqual([]);
    expect(labelsOf("a", "t1")).toEqual(["STARRED"]);

    await act(() => result.current.undoLast());
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
  });

  it("in STARRED, star unstars and the row leaves", async () => {
    seed("a", "t1", 100, ["STARRED"]);
    const { result } = await loaded("STARRED");
    await act(() => result.current.star({ accountId: "a", threadId: "t1" }));
    expect(starThread).toHaveBeenCalledWith("a", "t1", ["m-a-t1"], false);
    expect(archiveThread).not.toHaveBeenCalled();
    expect(result.current.rows).toEqual([]);
  });

  it("star unstars a starred conversation wherever it was opened", async () => {
    seed("a", "t1", 100, ["INBOX", "STARRED"]);
    const { result } = await loaded();
    await act(() => result.current.star({ accountId: "a", threadId: "t1" }));
    expect(starThread).toHaveBeenCalledWith("a", "t1", ["m-a-t1"], false);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("actions hit the right account when thread ids collide", async () => {
    seed("a", "same", 100, ["INBOX"]);
    seed("b", "same", 200, ["INBOX"]);
    const { result } = await loaded();

    await act(() => result.current.done({ accountId: "b", threadId: "same" }));
    expect(archiveThread).toHaveBeenCalledTimes(1);
    expect(archiveThread).toHaveBeenCalledWith("b", "same", ["m-b-same"]);
    expect(vi.mocked(getEmailProvider).mock.calls.map((c) => c[0])).toEqual([
      "b",
    ]);
    expect(ids(result.current.rows)).toEqual(["a:same"]);
    expect(labelsOf("a", "same")).toEqual(["INBOX"]);
    expect(labelsOf("b", "same")).toEqual([]);
  });

  it("undo while offline reverts the queued operation", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    useUIStore.setState({ isOnline: false });
    const { result } = await loaded();

    await act(() => result.current.done({ accountId: "a", threadId: "t1" }));
    expect(
      sqlite.prepare("SELECT operation_type FROM pending_operations").all(),
    ).toEqual([{ operation_type: "archive" }]);

    await act(() => result.current.undoLast());
    expect(
      sqlite.prepare("SELECT operation_type FROM pending_operations").all(),
    ).toEqual([]);
    expect(labelsOf("a", "t1")).toEqual(["INBOX"]);
    expect(provider.archive).not.toHaveBeenCalled();
  });

  it("deletes a spam batch locally before Gmail answers, and a reload keeps it gone", async () => {
    seed("a", "t1", 100, ["SPAM"]);
    seed("a", "t2", 200, ["SPAM"]);
    seed("a", "t3", 300, ["SPAM"]);
    useVoaStore.setState({ list: "SPAM" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.trash.mockImplementation(() => gate);
    const { result } = await loaded("SPAM");
    const keys = [
      { accountId: "a", threadId: "t1" },
      { accountId: "a", threadId: "t2" },
      { accountId: "a", threadId: "t3" },
    ];

    let finished = Promise.resolve();
    act(() => {
      finished = result.current.remove(keys);
    });

    await waitFor(() => {
      expect(labelsOf("a", "t1")).toEqual(["TRASH"]);
      expect(labelsOf("a", "t2")).toEqual(["TRASH"]);
      expect(labelsOf("a", "t3")).toEqual(["TRASH"]);
    });
    expect(result.current.rows).toEqual([]);
    expect((await getPendingOpsForResource("a", "t2")).map((op) => op.status)).toEqual(["executing"]);

    window.dispatchEvent(new Event("voa-sync-done"));
    await waitFor(() => expect(result.current.rows).toEqual([]));
    expect(labelsOf("a", "t2")).toEqual(["TRASH"]);

    release();
    await act(() => finished);
    expect(provider.trash).toHaveBeenCalledTimes(3);
    expect(await getPendingOpsForResource("a", "t2")).toEqual([]);
    expect(result.current.rows).toEqual([]);
  });

  it("archives a batch locally before Gmail answers", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    seed("a", "t2", 200, ["INBOX"]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.archive.mockImplementation(() => gate);
    const { result } = await loaded();
    const keys = [
      { accountId: "a", threadId: "t1" },
      { accountId: "a", threadId: "t2" },
    ];

    let finished = Promise.resolve();
    act(() => {
      finished = result.current.archiveMany(keys);
    });

    await waitFor(() => expect(labelsOf("a", "t1")).toEqual([]));
    expect(labelsOf("a", "t2")).toEqual([]);
    expect(result.current.rows).toEqual([]);
    expect((await getPendingOpsForResource("a", "t1")).map((op) => op.status)).toEqual(["executing"]);

    release();
    await act(() => finished);
    expect(provider.archive).toHaveBeenCalledTimes(2);
    expect(await getPendingOpsForResource("a", "t1")).toEqual([]);
  });

  it("filter shows one account; counts and accounts stay whole", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    seed("b", "t2", 200, ["INBOX"]);
    useVoaStore.setState({ filter: "b" });
    const { result } = await loaded();
    expect(ids(result.current.rows)).toEqual(["b:t2"]);
    expect(result.current.counts).toEqual({ a: 1, b: 1 });
    expect(result.current.accounts.map((a) => a.name)).toEqual([
      "me@home.com",
      "me@work.com",
    ]);
  });

  it("next is the following row, or null at the end", async () => {
    seed("a", "t1", 100, ["INBOX"]);
    seed("b", "t2", 200, ["INBOX"]);
    const { result } = await loaded();
    expect(result.current.next({ accountId: "b", threadId: "t2" })).toEqual({
      accountId: "a",
      threadId: "t1",
    });
    expect(result.current.next({ accountId: "a", threadId: "t1" })).toBeNull();
  });
});
