import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/services/snooze/snoozeManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/snooze/snoozeManager")>()),
  remindLater: vi.fn(async () => {}),
  cancelRemind: vi.fn(async () => {}),
}));

import { getDb } from "@/services/db/connection";
import { SnoozeLabelUnavailable, cancelRemind, remindLater } from "@/services/snooze/snoozeManager";
import { presetTime } from "../remind/remindTime";
import { useVoaStore } from "@/stores/list";
import { useToastStore } from "../ui/Toast";
import { InboxScreen } from "./InboxScreen";
import { realSource } from "./source";
import { asDb, createInboxDb, findSelectedRow, seed } from "./inboxDb.test-helper";

let sqlite: DatabaseSync;
const now = new Date(2026, 10, 11, 10, 0);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

beforeEach(async () => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has none
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  sqlite = await createInboxDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
  useToastStore.setState({ current: null, lastUndo: null });
  useVoaStore.setState({ filter: null, selected: null, list: "INBOX", pile: "mail", hidden: new Set() });
  seed(sqlite, "a", "t1", now.getTime(), ["INBOX"]);
});

afterEach(() => vi.useRealTimers());

async function remindTomorrow() {
  render(<InboxScreen list="INBOX" />);
  await findSelectedRow("S t1");
  fireEvent.keyDown(window, { key: "h" });
  fireEvent.click(await screen.findByRole("option", { name: /Tomorrow morning/ }));
  await waitFor(() => expect(screen.queryByText("S t1")).toBeNull());
}

describe("InboxScreen selection", () => {
  it("cmd+a selects every row, cmd-click drops one, shift-click fills the range, escape clears", async () => {
    seed(sqlite, "a", "t2", now.getTime() - 60_000, ["INBOX"]);
    seed(sqlite, "a", "t3", now.getTime() - 120_000, ["INBOX"]);
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("S t1");
    expect(screen.getByRole("banner").querySelector('[aria-label="Lists"]')).toBeTruthy();

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(screen.getAllByRole("row").every((row) => row.getAttribute("aria-selected") === "true")).toBe(true);

    const marked = (subject: string) =>
      screen.getByText(subject).closest('[role="row"]')?.getAttribute("aria-selected");

    fireEvent.click(screen.getByText("S t2"), { metaKey: true });
    expect(marked("S t1")).toBe("true");
    expect(marked("S t2")).toBe("false");
    expect(marked("S t3")).toBe("true");

    fireEvent.click(screen.getByText("S t3"), { shiftKey: true });
    expect(marked("S t1")).toBe("false");
    expect(marked("S t2")).toBe("true");
    expect(marked("S t3")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getAllByRole("row").filter((row) => row.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("clicking outside the rows clears the selection, and a button does not", async () => {
    seed(sqlite, "a", "t2", now.getTime() - 60_000, ["INBOX"]);
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("S t1");
    const selectedCount = () =>
      screen.getAllByRole("row").filter((row) => row.getAttribute("aria-selected") === "true").length;

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(selectedCount()).toBe(2);

    fireEvent.click(screen.getAllByRole("button", { name: /^Remind me/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Lists" }));
    expect(selectedCount()).toBe(2);

    fireEvent.click(screen.getByRole("heading", { name: "Today" }));
    expect(selectedCount()).toBe(1);

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    fireEvent.click(screen.getByRole("banner"));
    expect(selectedCount()).toBe(1);
  });
});

describe("InboxScreen selection and the view", () => {
  async function pickAllThen(change: () => void) {
    seed(sqlite, "b", "w1", now.getTime() - 60_000, ["INBOX"]);
    seed(sqlite, "a", "p1", now.getTime() - 120_000, ["INBOX", "CATEGORY_PROMOTIONS"]);
    const trashMany = vi.spyOn(realSource, "trashMany").mockResolvedValue();
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("S w1");
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    act(change);
    await waitFor(() => expect(screen.queryByText("S t1")).toBeNull());
    fireEvent.keyDown(window, { key: "Backspace" });
    await act(async () => {});
    const calls = [...trashMany.mock.calls];
    trashMany.mockRestore();
    return calls;
  }

  it("an account tab clears the selection: delete never reaches rows that left the screen", async () => {
    expect(await pickAllThen(() => useVoaStore.getState().setFilter("b"))).toEqual([]);
  });

  it("the Promotions pile clears the selection too", async () => {
    expect(await pickAllThen(() => useVoaStore.getState().setPile("promotions"))).toEqual([]);
  });
});

describe("InboxScreen Escape", () => {
  it("from an account or from Promotions goes back to the Inbox of every account", async () => {
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("S t1");
    for (const view of [{ filter: "a", pile: "mail" as const }, { filter: null, pile: "promotions" as const }]) {
      act(() => useVoaStore.setState(view));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useVoaStore.getState()).toMatchObject({ filter: null, pile: "mail" });
    }
  });
});

describe("InboxScreen selection and sync", () => {
  async function pickAllThenSyncDrops(key: string, action: "archiveMany" | "trashMany") {
    seed(sqlite, "a", "t2", now.getTime() - 60_000, ["INBOX"]);
    const spy = vi.spyOn(realSource, action).mockResolvedValue();
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("S t2");
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    sqlite.exec("DELETE FROM thread_labels WHERE thread_id = 't2'");
    act(() => void window.dispatchEvent(new Event("voa-sync-done")));
    await waitFor(() => expect(screen.queryByText("S t2")).toBeNull());
    fireEvent.keyDown(window, { key });
    await act(async () => {});
    const calls = [...spy.mock.calls];
    spy.mockRestore();
    return calls;
  }

  it("done acts only on picked rows still on screen", async () => {
    expect(await pickAllThenSyncDrops("e", "archiveMany")).toEqual([[[{ accountId: "a", threadId: "t1" }]]]);
  });

  it("delete acts only on picked rows still on screen", async () => {
    expect(await pickAllThenSyncDrops("Backspace", "trashMany")).toEqual([[[{ accountId: "a", threadId: "t1" }]]]);
  });
});

describe("InboxScreen remind me", () => {
  it("h then a preset calls remindLater with presetTime", async () => {
    await remindTomorrow();
    expect(remindLater).toHaveBeenCalledWith({ accountId: "a", threadId: "t1" }, ["m-a-t1"], unix(presetTime("tomorrow", now)));
    expect(useToastStore.getState().current?.message).toBe("Snoozed until Thu 08:00");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("undo after remind calls cancelRemind", async () => {
    await remindTomorrow();
    await act(() => useToastStore.getState().undoLast());
    expect(cancelRemind).toHaveBeenCalledWith({ accountId: "a", threadId: "t1" }, ["m-a-t1"]);
  });

  it("offline before the first snooze, the row stays and the toast says why, with no undo", async () => {
    const earlierUndo = vi.fn(async () => {});
    useToastStore.setState({ lastUndo: earlierUndo });
    vi.mocked(remindLater).mockRejectedValueOnce(new SnoozeLabelUnavailable(new Error("offline")));
    render(<InboxScreen list="INBOX" />);
    await findSelectedRow("S t1");
    fireEvent.keyDown(window, { key: "h" });
    fireEvent.click(await screen.findByRole("option", { name: /Tonight/ }));
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Couldn't snooze, try again online"));
    expect(screen.getByText("S t1")).toBeTruthy();
    expect(useToastStore.getState().current?.undoable).toBe(false);
    expect(useToastStore.getState().lastUndo).toBe(earlierUndo); // Z still undoes the action before
  });

  it("in Snoozed, a row shows when it comes back", async () => {
    sqlite.exec("DELETE FROM thread_labels");
    sqlite.exec(`UPDATE threads SET is_snoozed = 1, snooze_until = ${unix(presetTime("nextWeek", now))}`);
    sqlite.exec("INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES ('t1', 'a', 'SNOOZED')");
    render(<InboxScreen list="SNOOZED" />);
    expect(await screen.findByText("Mon 08:00")).toBeTruthy();
  });

  it("h in Snoozed snoozes again; the row stays and undo puts the old time back", async () => {
    const old = unix(presetTime("nextWeek", now));
    sqlite.exec("DELETE FROM thread_labels");
    sqlite.exec(`UPDATE threads SET is_snoozed = 1, snooze_until = ${old}`);
    sqlite.exec("INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES ('t1', 'a', 'SNOOZED')");
    render(<InboxScreen list="SNOOZED" />);
    await findSelectedRow("S t1");
    fireEvent.keyDown(window, { key: "h" });
    fireEvent.click(await screen.findByRole("option", { name: /Tonight/ }));
    const key = { accountId: "a", threadId: "t1" };
    await waitFor(() => expect(remindLater).toHaveBeenCalledWith(key, ["m-a-t1"], unix(presetTime("tonight", now))));
    expect(screen.getByText("S t1")).toBeTruthy();
    await act(() => useToastStore.getState().undoLast());
    expect(remindLater).toHaveBeenLastCalledWith(key, ["m-a-t1"], old);
    expect(cancelRemind).not.toHaveBeenCalled();
  });
});
