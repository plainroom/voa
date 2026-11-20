import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tanstack/react-router")>()), useNavigate: () => navigate }));
vi.mock("@/services/db/contacts", () => ({ searchContacts: vi.fn(async () => []), upsertContact: vi.fn(async () => {}) }));
const forgetUnsentMessage = vi.fn(async (_id: string) => {});
vi.mock("./signature", async (importOriginal) => ({ ...(await importOriginal<typeof import("./signature")>()), getSignature: async () => "" }));
vi.mock("./unsentMessages", () => ({ forgetUnsentMessage: (id: string) => forgetUnsentMessage(id) }));

import { realSource, setDemoSource, type InboxSource } from "../inbox/source";
import { useToastStore } from "../ui/Toast";
import { ComposeScreen } from "./ComposeScreen";
import { clearDraft, noteOpenThread, resetLastOpened, stashDraft } from "./draftStash";

const accounts = [
  { id: "a", name: "Personal", email: "me@home.com", color: "account-1", synced: true },
  { id: "b", name: "Work", email: "me@work.com", color: "account-2", synced: true },
];
let lastFrom: string | null;
let source: InboxSource;

beforeEach(() => {
  vi.clearAllMocks();
  lastFrom = null;
  resetLastOpened();
  clearDraft();
  useToastStore.setState({ current: null, lastUndo: null });
  source = {
    ...realSource,
    accounts: async () => accounts,
    promotions: async () => [],
    lastFromAccount: async () => lastFrom,
    setLastFromAccount: vi.fn(async (id: string) => void (lastFrom = id)),
    send: vi.fn(async () => {}),
  };
  setDemoSource(source);
});
afterEach(() => setDemoSource(realSource));

const fromValue = async () => {
  const select = (await screen.findByLabelText("From")) as HTMLSelectElement;
  await act(async () => {});
  return select.value;
};

const addRecipient = (address: string) => {
  const to = screen.getByLabelText("To");
  fireEvent.change(to, { target: { value: address } });
  fireEvent.keyDown(to, { key: "Enter" });
};

describe("ComposeScreen", () => {
  it("From defaults to the open thread's account", async () => {
    lastFrom = "a";
    noteOpenThread("b");
    render(<ComposeScreen />);
    expect(await fromValue()).toBe("b");
  });

  it("From falls back to the account last sent from, then the first", async () => {
    lastFrom = "b";
    const { unmount } = render(<ComposeScreen />);
    expect(await fromValue()).toBe("b");
    unmount();
    lastFrom = null;
    render(<ComposeScreen />);
    expect(await fromValue()).toBe("a");
  });

  it("Cmd+Enter sends from the chosen account, remembers it and goes back", async () => {
    noteOpenThread("b");
    render(<ComposeScreen />);
    await fromValue();
    addRecipient("ana@example.com");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(source.send).toHaveBeenCalledWith("b", { from: "me@work.com", to: ["ana@example.com"], subject: "Hello", html: "" });
    expect(source.setLastFromAccount).toHaveBeenCalledWith("b");
    expect(useToastStore.getState().current?.message).toBe("Sent");
  });

  it("an address typed but not yet a chip still goes", async () => {
    render(<ComposeScreen />);
    await fromValue();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "typed@example.com" } });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(source.send).toHaveBeenCalled());
    expect(vi.mocked(source.send).mock.calls[0]![1].to).toEqual(["typed@example.com"]);
  });

  it("without a recipient nothing is sent", async () => {
    render(<ComposeScreen />);
    await fromValue();
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    expect(source.send).not.toHaveBeenCalled();
    expect(useToastStore.getState().current?.message).toBe("Add a recipient");
  });

  it("a failed send closes nothing for good: its toast's Open brings the message back", async () => {
    vi.mocked(source.send).mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = render(<ComposeScreen />);
    await fromValue();
    addRecipient("ana@example.com");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Plans" } });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Couldn't send."));
    first.unmount();

    act(() => useToastStore.getState().current!.action!.run());
    expect(navigate).toHaveBeenLastCalledWith({ to: "/compose" });
    render(<ComposeScreen />);
    await fromValue();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Plans");
    expect(screen.getByText("ana@example.com")).toBeTruthy();
  });

  it("a send of unknown outcome says to check Sent and is not sent again", async () => {
    const { MaybeSentError } = await import("../inbox/source");
    vi.mocked(source.send).mockRejectedValueOnce(new MaybeSentError());
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ComposeScreen />);
    await fromValue();
    addRecipient("ana@example.com");
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("It may have been sent. Check Sent before sending again."));
    expect(source.send).toHaveBeenCalledTimes(1);
  });

  it("a message reopened from an unsent one drops the stored copy only once sent", async () => {
    stashDraft({ accountId: "a", to: ["ana@example.com"], subject: "Plans", html: "<p>Hi</p>", unsentId: "op-1" });
    vi.mocked(source.send).mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = render(<ComposeScreen />);
    await fromValue();
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Couldn't send."));
    expect(forgetUnsentMessage).not.toHaveBeenCalled();
    first.unmount();

    act(() => useToastStore.getState().current!.action!.run());
    render(<ComposeScreen />);
    await fromValue();
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Sent"));
    expect(forgetUnsentMessage).toHaveBeenCalledWith("op-1");
  });

  it("discarding a message reopened from an unsent one drops the stored copy", async () => {
    stashDraft({ accountId: "a", to: ["ana@example.com"], subject: "Plans", html: "<p>Hi</p>", unsentId: "op-1" });
    render(<ComposeScreen />);
    await fromValue();
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Escape" });
    expect(forgetUnsentMessage).toHaveBeenCalledWith("op-1");
  });

  it("Esc discards with an Undo that brings the draft back", async () => {
    const first = render(<ComposeScreen />);
    await fromValue();
    addRecipient("ana@example.com");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Keep me" } });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Escape" });
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(useToastStore.getState().current?.message).toBe("Draft discarded");
    first.unmount();

    await act(async () => useToastStore.getState().undoLast());
    expect(navigate).toHaveBeenCalledWith({ to: "/compose" });
    render(<ComposeScreen />);
    await fromValue();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Keep me");
    expect(screen.getByText("ana@example.com")).toBeTruthy();
  });

  it("Esc on an empty message just goes back", async () => {
    render(<ComposeScreen />);
    await fromValue();
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Escape" });
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(useToastStore.getState().current).toBeNull();
  });

  it("Send closes the screen at once and says Sent once the send lands", async () => {
    let finish: () => void = () => {};
    source.send = vi.fn(() => new Promise<void>((r) => void (finish = r)));
    render(<ComposeScreen />);
    await fromValue();
    addRecipient("ana@example.com");
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(source.send).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(useToastStore.getState().current?.message).toBe("Sending…");
    await act(async () => finish());
    expect(useToastStore.getState().current?.message).toBe("Sent");
  });
});
