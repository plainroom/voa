import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DbThread, ThreadKey } from "@/services/db/threads";
import type { DbMessage } from "@/services/db/messages";
import type { DbAttachment } from "@/services/db/attachments";

const navigate = vi.fn();
let params = { accountId: "a", threadId: "t2" };
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, useParams: () => params }));
vi.mock("@/voa/thread/InlineReply", () => ({ InlineReply: () => <div data-testid="reply-box" /> }));
vi.mock("@/voa/thread/EmailRenderer", async () => {
  const { useEffect } = await import("react");
  return {
    // Sized as soon as it is drawn, and again when asked (`resize-${html}` events), as the real frame is per document.
    EmailRenderer: ({ html, inlineAttachments, onSized }: { html: string; inlineAttachments?: { content_id: string }[]; onSized?: () => void }) => {
      useEffect(() => {
        onSized?.();
        const again = () => onSized?.();
        window.addEventListener(`resize-${html}`, again);
        return () => window.removeEventListener(`resize-${html}`, again);
      }, [html, onSized]);
      return <div data-inline={(inlineAttachments ?? []).map((a) => a.content_id).join(",")}>{html}</div>;
    },
  };
});

import { useComposerStore } from "@/stores/composerStore";
import { inboxSource, realSource, setDemoSource, type InboxSource } from "../inbox/source";
import { useVoaStore } from "@/stores/list";
import { useToastStore } from "../ui/Toast";
import { ThreadScreen } from "./ThreadScreen";

const thread = (id: string, at: number, isRead = 1): DbThread =>
  ({ id, account_id: "a", subject: `S ${id}`, snippet: "", last_message_at: at, message_count: 1, is_read: isRead, from_name: "Sender", from_address: "s@x.com", snooze_until: null }) as DbThread;

const message = (id: string): DbMessage => ({ id: `m-${id}`, account_id: "a", thread_id: id, from_name: "Sender", from_address: "s@x.com", date: 1, snippet: "", body_html: `body ${id}`, body_text: null }) as DbMessage;

let inbox: DbThread[];
let source: InboxSource;
const archived: string[] = [];
const keyOf = (t: DbThread): ThreadKey => ({ accountId: t.account_id, threadId: t.id });

beforeEach(() => {
  vi.clearAllMocks();
  archived.length = 0;
  params = { accountId: "a", threadId: "t2" };
  // newest first: t3, t2, t1
  inbox = [thread("t3", 300), thread("t2", 200, 0), thread("t1", 100)];
  source = {
    ...realSource,
    accounts: async () => [{ id: "a", name: "Personal", email: "me@x.com", color: "account-1" }],
    threads: async () => inbox.filter((t) => !archived.includes(t.id)),
    promotions: async () => [],
    counts: async () => ({ a: inbox.length - archived.length }),
    thread: async (k) => inbox.find((t) => t.id === k.threadId),
    messages: async (k) => [message(k.threadId)],
    markRead: vi.fn(async () => {}),
    imagePolicy: async () => ({ block: true, allowed: new Set() }),
    archive: async (k) => void archived.push(k.threadId),
    attachments: async () => [],
    openAttachment: vi.fn(async () => {}),
    spam: vi.fn(async () => {}),
    unspam: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    block: vi.fn(async () => ({ address: "s@x.com", threads: [] as ThreadKey[] })),
    unblock: vi.fn(async () => {}),
  };
  setDemoSource(source);
  useVoaStore.setState({ filter: null, selected: null, list: "INBOX", pile: "mail", hidden: new Set() });
  useToastStore.setState({ current: null, lastUndo: null });
  useComposerStore.setState({ isOpen: false });
});

afterEach(() => setDemoSource(realSource));

async function open() {
  render(<ThreadScreen />);
  await screen.findByText("body t2");
  await waitFor(() => expect(screen.getByText("S t2")).toBeTruthy());
  // the list behind it has loaded: next() needs its rows
  await waitFor(() => expect(inboxSource()).toBe(source));
  await act(async () => {});
}

describe("ThreadScreen", () => {
  it("a conversation a search stored with headers only fetches its bodies on open, then marks it read", async () => {
    let fetched = false;
    let finish = () => {};
    source.messages = async (k) => [fetched ? message(k.threadId) : { ...message(k.threadId), body_html: null, snippet: "preview t2", body_pending: 1 }];
    source.fetchBodies = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            fetched = true;
            resolve();
          };
        }),
    );
    const replies = vi.fn();
    window.addEventListener("voa-inline-reply", replies);
    render(<ThreadScreen />);
    await screen.findByText("Loading…");
    expect(source.fetchBodies).toHaveBeenCalledWith({ accountId: "a", threadId: "t2" });
    expect(source.markRead).not.toHaveBeenCalled();
    // No reply from a row without Message-ID, To or Reply-To: the box waits, and R and A do nothing.
    expect(screen.queryByTestId("reply-box")).toBeNull();
    expect(screen.getByText("Reply opens once the message has loaded.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "a" });
    expect(replies).not.toHaveBeenCalled();
    await act(async () => finish());
    await screen.findByText("body t2");
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByTestId("reply-box")).toBeTruthy();
    fireEvent.keyDown(window, { key: "r" });
    expect(replies).toHaveBeenCalledTimes(1);
    window.removeEventListener("voa-inline-reply", replies);
    await waitFor(() => expect(source.markRead).toHaveBeenCalled());
  });

  it("a body that could not be fetched leaves the preview", async () => {
    source.messages = async (k) => [{ ...message(k.threadId), body_html: null, snippet: "preview t2", body_pending: 1 }];
    source.fetchBodies = vi.fn(async () => {
      throw new Error("offline");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ThreadScreen />);
    await screen.findByText("preview t2", { selector: "p" });
    expect(await screen.findByText("Reply needs the full message, which couldn't be loaded.")).toBeTruthy();
    expect(screen.queryByTestId("reply-box")).toBeNull();
    error.mockRestore();
  });

  it("a body the provider no longer has says so, under the preview", async () => {
    source.messages = async (k) => [{ ...message(k.threadId), body_html: null, snippet: "preview t2", body_unavailable: 1 }];
    render(<ThreadScreen />);
    await screen.findByText("This message is no longer available.");
    expect(screen.getByText("preview t2", { selector: "p" })).toBeTruthy();
    expect(screen.queryByTestId("reply-box")).toBeNull();
  });

  it("a conversation of several messages opens scrolled to the newest, once its body has its height", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    source.messages = async (k) => [message(k.threadId), { ...message(k.threadId), id: "m-new", body_html: "newest" }];
    render(<ThreadScreen />);
    await screen.findByText("newest");
    // The body reports its height after it is drawn, so the scroll can land a tick later.
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]).toContain("newest");
    // drawn again (Translate): the page stays where the person is
    act(() => void window.dispatchEvent(new Event("resize-newest")));
    expect(scrolled).toHaveLength(1);
  });

  it("a conversation of one message does not scroll", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await open();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("shows the subject, the message and the reply box, and marks the thread read", async () => {
    await open();
    expect(screen.getByText("body t2")).toBeTruthy();
    expect(screen.getByTestId("reply-box")).toBeTruthy();
    expect(source.markRead).toHaveBeenCalledWith({ accountId: "a", threadId: "t2" });
  });

  it("e on an open thread opens the next one", async () => {
    await open();
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t1" } }));
    expect(archived).toEqual(["t2"]);
    expect(useVoaStore.getState().selected).toEqual(keyOf(inbox[2]!));
  });

  it("e on the last thread returns to the list", async () => {
    params = { accountId: "a", threadId: "t1" };
    render(<ThreadScreen />);
    await screen.findByText("body t1");
    await act(async () => {});
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    // the list is told only after the archive landed
    expect(archived).toEqual(["t1"]);
  });

  it("Esc returns to the list with the thread selected", async () => {
    await open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(useVoaStore.getState().selected).toEqual({ accountId: "a", threadId: "t2" });
  });

  it("keys typed in the reply box do not act on the thread", async () => {
    await open();
    const field = document.createElement("textarea"); // jsdom has no isContentEditable
    document.body.append(field);
    fireEvent.keyDown(field, { key: "e" });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.keyDown(field, { key: "!" });
    expect(navigate).not.toHaveBeenCalled();
    expect(archived).toEqual([]);
    expect(source.spam).not.toHaveBeenCalled();
    field.remove();
  });

  it("r and a ask the inline reply to open", async () => {
    await open();
    const modes: string[] = [];
    const on = (e: Event) => modes.push((e as CustomEvent).detail.mode);
    window.addEventListener("voa-inline-reply", on);
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "a" });
    window.removeEventListener("voa-inline-reply", on);
    expect(modes).toEqual(["reply", "replyAll"]);
  });

  it("lists a message's files under it, opens one on click, and gives its cid: images to the renderer", async () => {
    const file = (id: string, filename: string | null, extra: Partial<DbAttachment> = {}): DbAttachment => ({
      id,
      message_id: "m-t2",
      account_id: "a",
      filename,
      mime_type: "application/pdf",
      size: 2048,
      gmail_attachment_id: `g-${id}`,
      content_id: null,
      is_inline: 0,
      local_path: null,
      ...extra,
    });
    const pdf = file("1", "Proposal.pdf");
    const logo = file("2", "logo.png", { content_id: "logo@x", is_inline: 1 });
    source.messages = async () => [{ ...message("t2"), body_html: '<img src="cid:logo@x">' }];
    source.attachments = async () => [pdf, logo, file("3", "Proposal.pdf")];
    await act(async () => render(<ThreadScreen />));

    const chip = await screen.findByRole("button", { name: /Proposal\.pdf/ });
    expect(chip.textContent).toContain("2.0 KB");
    expect(screen.queryByRole("button", { name: /logo\.png/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Proposal\.pdf/ })).toHaveLength(1);
    expect(document.querySelector("[data-inline]")?.getAttribute("data-inline")).toBe("logo@x");

    await act(async () => fireEvent.click(chip));
    expect(source.openAttachment).toHaveBeenCalledWith(pdf);
  });

  it("a file that cannot be opened says so", async () => {
    source.attachments = async () => [{ id: "1", message_id: "m-t2", account_id: "a", filename: "a.pdf", mime_type: null, size: 1, gmail_attachment_id: "g", content_id: null, is_inline: 0, local_path: null }];
    source.openAttachment = vi.fn(async () => {
      throw new Error("offline");
    });
    await act(async () => render(<ThreadScreen />));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: /a\.pdf/ })));
    expect(useToastStore.getState().current?.message).toBe("Couldn't open a.pdf");
  });

  it("offers Spam and Block when the message has no unsubscribe", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Spam" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Star" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).toBeNull();
  });

  it("offers Unsubscribe instead of Block when the message can unsubscribe", async () => {
    source.messages = async (k) => [{ ...message(k.threadId), list_unsubscribe: "<https://example.com/unsub>" }];
    await open();
    expect(screen.getByRole("button", { name: "Unsubscribe" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
    expect(screen.getByRole("button", { name: "Spam" })).toBeTruthy();
  });

  it("does not offer Block for the account's own address", async () => {
    source.accounts = async () => [{ id: "a", name: "Personal", email: "s@x.com", color: "account-1" }];
    await open();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Block" })).toBeNull());
    expect(screen.getByRole("button", { name: "Spam" })).toBeTruthy();
  });

  it("! and Spam mark the thread as spam and open the next one", async () => {
    await open();
    fireEvent.keyDown(window, { key: "!" });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t1" } }));
    expect(source.spam).toHaveBeenCalledWith({ accountId: "a", threadId: "t2" });
  });

  it("Block records the sender and opens the next thread", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() => expect(source.block).toHaveBeenCalledWith({ accountId: "a", threadId: "t2" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t1" } });
  });

  it("Unsubscribe archives and moves on, and a failure offers Block instead", async () => {
    source.messages = async (k) => [{ ...message(k.threadId), list_unsubscribe: "<https://example.com/unsub>" }];
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(archived).toEqual(["t2"]));
    expect(source.unsubscribe).toHaveBeenCalledWith({ accountId: "a", threadId: "t2" });
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t1" } });
  });

  it("a failed unsubscribe stays on the thread and offers Block", async () => {
    source.messages = async (k) => [{ ...message(k.threadId), list_unsubscribe: "<https://example.com/unsub>" }];
    source.unsubscribe = vi.fn(async () => {
      throw new Error("no");
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    expect(await screen.findByRole("button", { name: "Block" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(archived).toEqual([]);
    expect(useToastStore.getState().current?.message).toBe("Couldn't unsubscribe");
  });
});
