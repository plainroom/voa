import { fireEvent, renderHook } from "@testing-library/react";
import { isSearchHotkey, useSearchHotkey } from "./useSearchHotkey";

const navigate = vi.fn();
let pathname = "/";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname } }),
}));

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  key: k,
  ...mods,
});

describe("search hotkey", () => {
  beforeEach(() => {
    navigate.mockClear();
    pathname = "/";
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  });
  afterEach(() => vi.restoreAllMocks());

  it("is Cmd+F on a Mac and Ctrl+F elsewhere, never the other modifier, Cmd+K, a shifted or alt key", () => {
    expect(isSearchHotkey(key("f", { metaKey: true }), true)).toBe(true);
    expect(isSearchHotkey(key("F", { metaKey: true }), true)).toBe(true);
    expect(isSearchHotkey(key("f", { ctrlKey: true }), true)).toBe(false);
    expect(isSearchHotkey(key("f", { ctrlKey: true }), false)).toBe(true);
    expect(isSearchHotkey(key("f", { metaKey: true }), false)).toBe(false);
    expect(isSearchHotkey(key("k", { metaKey: true }), true)).toBe(false);
    expect(isSearchHotkey(key("f", { metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSearchHotkey(key("f", { metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSearchHotkey(key("f"), true)).toBe(false);
  });

  it("opens search, and when already there only asks the field to focus", () => {
    const focused = vi.fn();
    window.addEventListener("voa-focus-search", focused);
    const first = renderHook(() => useSearchHotkey());
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: "/search", search: { q: "" } });
    expect(focused).toHaveBeenCalled();
    first.unmount();

    navigate.mockClear();
    pathname = "/search";
    renderHook(() => useSearchHotkey());
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
    window.removeEventListener("voa-focus-search", focused);
  });

  it("leaves Cmd+F to a reply or a draft being written, but takes it from its own field", () => {
    const focused = vi.fn();
    window.addEventListener("voa-focus-search", focused);
    renderHook(() => useSearchHotkey());
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const textarea = document.createElement("textarea");
    const search = document.createElement("input");
    search.dataset.searchField = "";
    document.body.append(editor, textarea, search);

    fireEvent.keyDown(editor, { key: "f", metaKey: true });
    fireEvent.keyDown(textarea, { key: "f", metaKey: true });
    expect(focused).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "f", metaKey: true });
    expect(focused).toHaveBeenCalledTimes(1);

    editor.remove();
    textarea.remove();
    search.remove();
    window.removeEventListener("voa-focus-search", focused);
  });
});
