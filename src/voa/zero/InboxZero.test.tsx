import { fireEvent, render, screen } from "@testing-library/react";
import { InboxZero } from "./InboxZero";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

const now = new Date(2026, 10, 11, 10, 0); // Wednesday
const base = { accountName: "Work", starred: 3, now, onStarred: vi.fn() };

describe("InboxZero", () => {
  it("allClear: All clear., the starred count and the date, and a photo credit", () => {
    render(<InboxZero {...base} state="allClear" />);
    expect(screen.getByText("All clear.")).toBeTruthy();
    expect(screen.getByText(/3 starred to follow up/)).toBeTruthy();
    expect(screen.getByText(/Wednesday, November 11/)).toBeTruthy();
    expect(screen.getByText(/on Unsplash/)).toBeTruthy();
  });

  it("allClear: the starred part is left out at 0, and clicking it opens Starred", () => {
    const { rerender } = render(<InboxZero {...base} state="allClear" />);
    fireEvent.click(screen.getByText(/3 starred to follow up/));
    expect(base.onStarred).toHaveBeenCalled();
    rerender(<InboxZero {...base} starred={0} state="allClear" />);
    expect(screen.queryByText(/starred/)).toBeNull();
    expect(screen.getByText("Wednesday, November 11")).toBeTruthy();
  });

  it("accountClear: a quiet line, no photo", () => {
    const { container } = render(<InboxZero {...base} state="accountClear" />);
    expect(screen.getByText("Work is clear")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

});
