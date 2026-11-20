import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Row, RowAction, lineOverflows } from "./Row";
import { useToastStore } from "./Toast";

function renderRow(selected: boolean) {
  return render(
    <Row
      dotColor="account-1"
      from="Marina Costa"
      subject="Revised proposal"
      preview="Hi, here is the version with the changes"
      date="10:42"
      selected={selected}
      unread
      onOpen={() => {}}
      actions={<RowAction label="Done" onClick={() => {}}>✓</RowAction>}
    />,
  );
}

describe("Row", () => {
  it("hides actions until hover and shows them when selected", () => {
    const { unmount } = renderRow(false);
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("Marina Costa"));
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByText("Marina Costa"));
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    unmount();

    renderRow(true);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("an action does not open the row", () => {
    const onOpen = vi.fn();
    const onDone = vi.fn();
    render(
      <Row
        dotColor="account-2"
        from="A"
        subject="S"
        preview="P"
        date="Tue"
        selected
        unread={false}
        onOpen={onOpen}
        actions={<RowAction label="Done" onClick={onDone}>✓</RowAction>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ellipsizes a line only when the words are wider than the column", () => {
    expect(lineOverflows(120, 400)).toBe(false);
    expect(lineOverflows(400, 400)).toBe(false);
    expect(lineOverflows(401, 400)).toBe(false);
    expect(lineOverflows(402, 400)).toBe(true);
    expect(lineOverflows(80, 0)).toBe(false);

    renderRow(false);
    expect(screen.getByText("Revised proposal").parentElement).not.toHaveClass("text-ellipsis");
  });

  it("copies a login code and does not open the row", async () => {
    const onOpen = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useToastStore.setState({ current: null, lastUndo: null });
    render(
      <Row dotColor={null} from="noreply" subject="Hotmart | 515766 is your login code" preview="" date="17:02" selected={false} unread code="515766" onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code 515766" }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("515766");
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Copied"));
  });

  it("shows a paperclip when the conversation has attachments", () => {
    const { rerender } = render(<Row dotColor={null} from="A" subject="S" preview="P" date="Tue" selected={false} unread={false} onOpen={() => {}} />);
    expect(screen.queryByLabelText("Has attachments")).toBeNull();
    rerender(<Row dotColor={null} from="A" subject="S" preview="P" date="Tue" selected={false} unread={false} attachment onOpen={() => {}} />);
    expect(screen.getByLabelText("Has attachments")).toBeInTheDocument();
  });
});
