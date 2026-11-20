import { renderHook, fireEvent } from "@testing-library/react";
import type { ThreadKey } from "@/services/db/threads";
import { useInboxKeys, type InboxKeyHandlers } from "./useInboxKeys";

const a1: ThreadKey = { accountId: "a", threadId: "1" };
const b1: ThreadKey = { accountId: "b", threadId: "1" };

function setup(selected: ThreadKey | null = b1) {
  const h: InboxKeyHandlers = {
    rows: [a1, b1],
    selected,
    accountIds: ["a", "b"],
    select: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(() => false),
    remove: vi.fn(),
    open: vi.fn(),
    done: vi.fn(),
    star: vi.fn(),
    remind: vi.fn(),
    undo: vi.fn(),
    compose: vi.fn(),
    search: vi.fn(),
    settings: vi.fn(),
    setFilter: vi.fn(),
    goList: vi.fn(),
  };
  renderHook(() => useInboxKeys(h));
  return h;
}

const press = (key: string, target: EventTarget = window) =>
  fireEvent.keyDown(target, { key });

describe("useInboxKeys", () => {
  it("e on selected calls done; 2 sets filter to second account; 0 clears it; g then s switches list", () => {
    const h = setup();
    press("e");
    expect(h.done).toHaveBeenCalledWith(b1);
    press("2");
    expect(h.setFilter).toHaveBeenCalledWith("b");
    press("0");
    expect(h.setFilter).toHaveBeenLastCalledWith(null);
    press("g");
    press("s");
    expect(h.goList).toHaveBeenCalledWith("STARRED");
    expect(h.star).not.toHaveBeenCalled();
  });

  it("j and k move the selection; Enter and o open; s stars; Cmd+Z undoes, z alone does not", () => {
    const h = setup(a1);
    press("j");
    expect(h.select).toHaveBeenLastCalledWith(b1);
    press("k");
    expect(h.select).toHaveBeenLastCalledWith(a1);
    press("Enter");
    press("o");
    expect(h.open).toHaveBeenCalledTimes(2);
    press("s");
    expect(h.star).toHaveBeenCalledWith(a1);
    press("h");
    expect(h.remind).toHaveBeenCalledWith(a1);
    press("z");
    expect(h.undo).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(h.undo).toHaveBeenCalledTimes(1);
  });

  it("g i and g h go to the inbox and snoozed; g p goes to spam; Esc goes to inbox; c composes; / searches", () => {
    const h = setup();
    press("g");
    press("i");
    press("g");
    press("h");
    press("g");
    press("p");
    press("Escape");
    expect(h.clearSelection).toHaveBeenCalled();
    expect(vi.mocked(h.goList).mock.calls).toEqual([
      ["INBOX"],
      ["SNOOZED"],
      ["SPAM"],
      ["INBOX"],
    ]);
    press("c");
    press("/");
    press(",");
    expect(h.compose).toHaveBeenCalled();
    expect(h.settings).toHaveBeenCalled();
    expect(h.search).toHaveBeenCalled();
  });

  it("ignores keys typed in a field and keys with a modifier", () => {
    const h = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("e", input);
    fireEvent.keyDown(window, { key: "e", metaKey: true });
    expect(h.done).not.toHaveBeenCalled();
    input.remove();
  });

  it("j with nothing selected selects the first row", () => {
    const h = setup(null);
    press("j");
    expect(h.select).toHaveBeenCalledWith(a1);
  });

  it("does nothing while a dialog is open", () => {
    const h = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    press("e");
    press("2");
    dialog.remove();

    expect(h.done).not.toHaveBeenCalled();
    expect(h.setFilter).not.toHaveBeenCalled();
    press("e");
    expect(h.done).toHaveBeenCalledWith(b1);
  });

  it("Enter on a focused button or link is left to it", () => {
    const h = setup();
    const button = document.createElement("button");
    const link = document.createElement("a");
    document.body.append(button, link);
    press("Enter", button);
    press("Enter", link);
    expect(h.open).not.toHaveBeenCalled();
    press("Enter");
    expect(h.open).toHaveBeenCalledWith(b1);
    button.remove();
    link.remove();
  });

  it("Backspace and Delete remove, and Cmd+A selects every row", () => {
    const h = setup();
    press("Backspace");
    press("Delete");
    expect(h.remove).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(h.selectAll).toHaveBeenCalled();
    expect(h.done).not.toHaveBeenCalled();
  });
});
