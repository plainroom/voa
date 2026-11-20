import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DbMessage } from "@/services/db/messages";
import type { Thread } from "@/stores/threadStore";

const scheduleReply = vi.fn();
const flushPendingReply = vi.fn();
vi.mock("./replySend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replySend")>()),
  scheduleReply: (...a: unknown[]) => scheduleReply(...a),
  flushPendingReply: () => flushPendingReply(),
}));
vi.mock("@/services/db/signatures", () => ({ getDefaultSignature: async () => null }));
let settingDelay: Promise<string> | null = null;
vi.mock("@/services/db/settings", () => ({ getSetting: async () => (settingDelay ? settingDelay : "5") }));
const getMessage = vi.fn();
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: async () => ({ getMessage: (...a: unknown[]) => getMessage(...a) }) }));
vi.mock("@/router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/services/db/connection", () => ({ getDb: async () => ({ execute: async () => ({}), select: async () => [] }) }));

import { useAccountStore } from "@/stores/accountStore";
import { HEADERS_TIMEOUT_MS, InlineReply } from "./InlineReply";
import { reopenReply, resetReplySend, type SavedReply } from "./replySend";

const thread = { id: "t1" } as Thread;
const mine = {
  id: "gmail-internal-id",
  account_id: "a",
  thread_id: "t1",
  from_address: "me@x.com",
  to_addresses: "Bob <bob@y.com>",
  cc_addresses: null,
  reply_to: null,
  subject: "Plans",
  message_id_header: "<rfc-id@mail.x.com>",
  references_header: null,
} as DbMessage;

const decode = (raw: string) => atob(raw.replace(/-/g, "+").replace(/_/g, "/"));

beforeEach(() => {
  vi.clearAllMocks();
  resetReplySend();
  settingDelay = null;
  Element.prototype.scrollIntoView = vi.fn();
  useAccountStore.setState({ accounts: [{ id: "a", email: "me@x.com", displayName: null, avatarUrl: null, isActive: true, provider: "gmail_api" }] });
});

describe("InlineReply", () => {
  it("a reply to the owner's own message goes to that message's To, threaded on its Message-ID", async () => {
    const { unmount } = render(<InlineReply thread={thread} messages={[mine]} accountId="a" onSent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Reply R$/ }));
    expect(screen.getByText("to Bob <bob@y.com>")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    });
    await waitFor(() => expect(scheduleReply).toHaveBeenCalledTimes(1));
    const [reply] = scheduleReply.mock.calls[0]! as [{ to: string[]; raw: string }];
    expect(reply.to).toEqual(["Bob <bob@y.com>"]);
    const headers = decode(reply.raw);
    expect(headers).toContain("In-Reply-To: <rfc-id@mail.x.com>");
    expect(headers).not.toContain("gmail-internal-id");

    unmount();
    expect(flushPendingReply).toHaveBeenCalled();
  });

  it("a conversation closed while the send is being prepared still schedules (and saves) it, and leaves the gone box alone", async () => {
    let release!: (v: string) => void;
    settingDelay = new Promise((r) => (release = r));
    const onSent = vi.fn();
    const { unmount } = render(<InlineReply thread={thread} messages={[mine]} accountId="a" onSent={onSent} />);
    fireEvent.click(screen.getByRole("button", { name: /^Reply R$/ }));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    });
    unmount();
    await act(async () => release("5"));
    await waitFor(() => expect(scheduleReply).toHaveBeenCalledTimes(1));
    expect(onSent).not.toHaveBeenCalled();
    // Undo with the box gone reopens the conversation instead of writing into a destroyed editor.
    const restore = scheduleReply.mock.calls[0]![2] as (r: SavedReply) => void;
    expect(() => restore({ ...(scheduleReply.mock.calls[0]![0] as SavedReply), id: "x", scheduledAt: 0, status: "scheduled" })).not.toThrow();
  });

  it("a reopened reply comes back in its conversation's box, in its mode", async () => {
    render(<InlineReply thread={thread} messages={[mine]} accountId="a" onSent={() => {}} />);
    act(() =>
      reopenReply({ id: "r1", accountId: "a", threadId: "t1", mode: "reply", to: ["bob@y.com"], cc: [], subject: "Re: Plans", html: "<p>back again</p>", scheduledAt: 0, status: "scheduled" }),
    );
    await waitFor(() => expect(screen.getByText("back again")).toBeTruthy());
    expect(screen.getByText("to Bob <bob@y.com>")).toBeTruthy();
  });

  it("a Message-ID fetch that hangs gives up after 10 s and the reply is still scheduled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMessage.mockReturnValue(new Promise(() => {}));
    const old = { ...mine, message_id_header: null } as DbMessage;
    render(<InlineReply thread={thread} messages={[old]} accountId="a" onSent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Reply R$/ }));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    });
    await waitFor(() => expect(getMessage).toHaveBeenCalled());
    expect(scheduleReply).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS);
    });
    await waitFor(() => expect(scheduleReply).toHaveBeenCalledTimes(1));
    expect(decode((scheduleReply.mock.calls[0]![0] as { raw: string }).raw)).not.toContain("In-Reply-To");
    vi.useRealTimers();
  });
});
