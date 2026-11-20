import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastHost, useToastStore } from "./Toast";

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ current: null });
  });
  afterEach(() => vi.useRealTimers());

  it("calls undo on click and disappears after 5 s", async () => {
    const undo = vi.fn(() => Promise.resolve());
    render(<ToastHost />);

    act(() => useToastStore.getState().show("Done", undo));
    expect(screen.getByText("Done")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Done")).not.toBeInTheDocument();

    act(() => useToastStore.getState().show("Starred", undo));
    expect(screen.getByText("Starred")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByText("Starred")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Starred")).not.toBeInTheDocument();
  });

  it("shows one toast at a time and undoes the latest", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    render(<ToastHost />);
    act(() => useToastStore.getState().show("One", first));
    act(() => useToastStore.getState().show("Two", second));
    expect(screen.queryByText("One")).not.toBeInTheDocument();
    await act(async () => {
      await useToastStore.getState().undoLast();
    });
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it("a notice has no Undo and keeps the last undo for Z", () => {
    const undo = vi.fn(() => Promise.resolve());
    render(<ToastHost />);
    act(() => useToastStore.getState().show("Done", undo));
    act(() => useToastStore.getState().show("Couldn't snooze, try again online"));
    expect(screen.getByText("Couldn't snooze, try again online")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(useToastStore.getState().lastUndo).toBe(undo);
  });
});

describe("Toast with an action", () => {
  beforeEach(() => useToastStore.setState({ current: null, lastUndo: null }));

  it("shows its own button, runs it and closes, and leaves Z's undo alone", () => {
    const undo = vi.fn(() => Promise.resolve());
    const run = vi.fn();
    useToastStore.setState({ lastUndo: undo });
    render(<ToastHost />);
    act(() => useToastStore.getState().showAction("Couldn't send", "Open", run));
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Couldn't send")).not.toBeInTheDocument();
    expect(useToastStore.getState().lastUndo).toBe(undo);
  });

  it("a toast shown while the window is hidden waits, and fades 5 s after the window is seen", () => {
    vi.useFakeTimers();
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<ToastHost />);
    act(() => useToastStore.getState().showAction("A message may not have been sent.", "Open", vi.fn()));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("A message may not have been sent.")).toBeInTheDocument();

    state.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByText("A message may not have been sent.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("A message may not have been sent.")).not.toBeInTheDocument();
    state.mockRestore();
    vi.useRealTimers();
  });
});
