import type { DatabaseSync } from "node:sqlite";

const sendEmail = vi.fn();
vi.mock("@/services/emailActions", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  archiveThread: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/services/db/contacts", () => ({
  upsertContact: vi.fn(async () => {}),
}));
const navigate = vi.fn();
vi.mock("@/router", () => ({
  router: { navigate: (...a: unknown[]) => navigate(...a) },
}));
let sqlite: DatabaseSync;
vi.mock("@/services/db/connection", async () => {
  const { asDb } = await import("@/voa/inbox/inboxDb.test-helper");
  return { getDb: async () => asDb(sqlite) };
});

import { useComposerStore } from "@/stores/composerStore";
import { useToastStore } from "@/voa/ui/Toast";
import {
  cancelPendingReply,
  flushPendingReply,
  hasPendingReply,
  MAYBE_SENT,
  NOT_SENT,
  REOPEN_EVENT,
  resetReplySend,
  savedReplies,
  scheduleReply,
  SEND_FAILED,
  surfaceUnsentReplies,
  takeReopenedReply,
  type OutgoingReply,
  type SavedReply,
} from "./replySend";

const reply: OutgoingReply = {
  accountId: "a",
  threadId: "t",
  mode: "replyAll",
  raw: "RAW",
  to: ["bob@y.com"],
  cc: ["dan@z.com"],
  subject: "Re: Hi",
  html: "<p>my answer</p>",
  inReplyTo: "<m1@x>",
  references: "<m0@x> <m1@x>",
};

const rows = () => savedReplies();
/** A row left by an earlier run of the app. */
const leftover = (r: Partial<SavedReply>) =>
  sqlite
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
    .run(
      `pending_reply:${r.id}`,
      JSON.stringify({
        ...reply,
        raw: undefined,
        scheduledAt: 1,
        status: "scheduled",
        ...r,
      }),
    );

beforeEach(async () => {
  vi.clearAllMocks();
  resetReplySend();
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  useToastStore.setState({ current: null, lastUndo: null });
  sendEmail.mockResolvedValue({ success: true });
});
afterEach(() => vi.useRealTimers());

describe("scheduleReply", () => {
  it("saves the reply the moment it is scheduled, with what reopens it threaded", async () => {
    vi.useFakeTimers();
    await scheduleReply(reply, 5000, vi.fn());
    const [saved] = await rows();
    expect(saved).toMatchObject({
      accountId: "a",
      threadId: "t",
      mode: "replyAll",
      to: ["bob@y.com"],
      cc: ["dan@z.com"],
      subject: "Re: Hi",
      html: "<p>my answer</p>",
      inReplyTo: "<m1@x>",
      references: "<m0@x> <m1@x>",
      status: "scheduled",
    });
    expect(saved!.scheduledAt).toBe(Date.now() + 5000);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends after the delay, once, and the saved row goes", async () => {
    vi.useFakeTimers();
    void scheduleReply(reply, 5000, vi.fn());
    expect(useComposerStore.getState().undoSendVisible).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith("a", "RAW", "t", expect.any(String));
    expect(useComposerStore.getState().undoSendVisible).toBe(false);
  });

  it("flush sends a waiting reply at once (its screen closed), and only once", async () => {
    vi.useFakeTimers();
    void scheduleReply(reply, 5000, vi.fn());
    await flushPendingReply();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(hasPendingReply()).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("the window unloading sends nothing: the reply stays saved for the next start", async () => {
    vi.useFakeTimers();
    await scheduleReply(reply, 5000, vi.fn());
    window.dispatchEvent(new Event("beforeunload"));
    await Promise.resolve();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
  });

  it("undo sends nothing, gives the reply back and removes the saved row", async () => {
    vi.useFakeTimers();
    const restore = vi.fn();
    await scheduleReply(reply, 5000, restore);
    await cancelPendingReply();
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<p>my answer</p>", mode: "replyAll" }),
    );
    await flushPendingReply();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it("an undo right after scheduling still removes the row (the delete waits for the insert)", async () => {
    vi.useFakeTimers();
    void scheduleReply(reply, 5000, vi.fn());
    await cancelPendingReply();
    expect(await rows()).toEqual([]);
  });

  it("a failed send keeps the row, says so, and Open puts it back in its conversation's reply box", async () => {
    vi.useFakeTimers();
    sendEmail.mockResolvedValue({ success: false, error: "403" });
    void scheduleReply(reply, 5000, vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe(SEND_FAILED),
    );
    expect((await rows())[0]!.status).toBe("failed");

    useToastStore.getState().current!.action!.run();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/t/$accountId/$threadId",
        params: { accountId: "a", threadId: "t" },
      }),
    );
    const back = takeReopenedReply("a", "t");
    expect(back).toMatchObject({ html: "<p>my answer</p>", mode: "replyAll" });
    // In the editor now: no longer saved, and a second take finds nothing.
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
    expect(takeReopenedReply("a", "t")).toBeNull();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a send of unknown outcome says it may have gone, keeps the row as sending, and is not sent again", async () => {
    vi.useFakeTimers();
    sendEmail.mockResolvedValue({ success: false, uncertain: true, error: "timed out" });
    void scheduleReply(reply, 5000, vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(useToastStore.getState().current?.message).toBe(MAYBE_SENT));
    expect((await rows())[0]!.status).toBe("sending");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a send in flight is marked sending before it reaches Gmail", async () => {
    let seen: SavedReply["status"] | undefined;
    sendEmail.mockImplementation(async () => {
      seen = (await rows())[0]?.status;
      return { success: true };
    });
    void scheduleReply(reply, 0, vi.fn());
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled());
    await vi.waitFor(() => expect(seen).toBe("sending"));
  });

  it("the send carries the saved reply's id, so its notice can tell its row from another reply's", async () => {
    sendEmail.mockResolvedValue({ success: true });
    void scheduleReply(reply, 0, vi.fn());
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled());
    const [, , threadId, replyId] = sendEmail.mock.calls[0]!;
    expect(threadId).toBe("t");
    expect(typeof replyId).toBe("string");
  });
});

describe("surfaceUnsentReplies (startup)", () => {
  it("shows a reply the app quit on, never sends it, and Open reopens it threaded in its reply box", async () => {
    leftover({ id: "r1", scheduledAt: 1 });
    const opened = vi.fn();
    window.addEventListener(REOPEN_EVENT, opened);
    await surfaceUnsentReplies(["a"]);
    const current = useToastStore.getState().current!;
    expect(current.message).toBe(NOT_SENT);
    expect(sendEmail).not.toHaveBeenCalled();

    current.action!.run();
    expect(opened).toHaveBeenCalled();
    window.removeEventListener(REOPEN_EVENT, opened);
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/t/$accountId/$threadId",
        params: { accountId: "a", threadId: "t" },
      }),
    );
    expect(takeReopenedReply("a", "t")).toMatchObject({
      inReplyTo: "<m1@x>",
      cc: ["dan@z.com"],
    });
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("one whose send had started may have gone: it says to check Sent first", async () => {
    leftover({ id: "r1", status: "sending" });
    await surfaceUnsentReplies(["a"]);
    expect(useToastStore.getState().current!.message).toBe(MAYBE_SENT);
  });

  it("a reply this session still holds is not shown as unsent", async () => {
    vi.useFakeTimers();
    await scheduleReply(reply, 5000, vi.fn());
    await surfaceUnsentReplies(["a"]);
    expect(useToastStore.getState().current).toBeNull();
  });

  it("a removed account's reply is dropped, not shown", async () => {
    leftover({ id: "r1", accountId: "gone" });
    await surfaceUnsentReplies(["a"]);
    expect(useToastStore.getState().current).toBeNull();
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
  });

  it("nothing saved, nothing shown", async () => {
    await surfaceUnsentReplies(["a"]);
    expect(useToastStore.getState().current).toBeNull();
  });
});
