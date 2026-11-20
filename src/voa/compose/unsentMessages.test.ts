import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
const navigate = vi.fn(async (_to: unknown) => {});
vi.mock("@/router", () => ({ router: { navigate: (to: unknown) => navigate(to) } }));

import { getDb } from "@/services/db/connection";
import { buildRawEmail } from "@/utils/emailBuilder";
import { asDb, createInboxDb } from "../inbox/inboxDb.test-helper";
import { useToastStore } from "../ui/Toast";
import { clearDraft, peekDraft } from "./draftStash";
import { MAYBE_NOT_SENT, NOT_SENT, resetUnsentMessages, surfaceUnsentMessages } from "./unsentMessages";

let sqlite: DatabaseSync;
const raw = buildRawEmail({ from: "me@home.com", to: ["ana@x.com"], subject: "Plans", htmlBody: "<p>See you</p>" });
const addSend = (id: string, status: string, params: Record<string, unknown>, at = 1) =>
  sqlite
    .prepare("INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at) VALUES (?, 'a', 'sendMessage', ?, ?, ?, ?)")
    .run(id, id, JSON.stringify(params), status, at);
const rows = () => (sqlite.prepare("SELECT id FROM pending_operations ORDER BY id").all() as { id: string }[]).map((r) => r.id);

beforeEach(async () => {
  vi.clearAllMocks();
  resetUnsentMessages();
  clearDraft();
  sqlite = await createInboxDb();
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
  useToastStore.setState({ current: null, lastUndo: null });
});

describe("surfaceUnsentMessages", () => {
  it("shows a new message a quit cut short, never sends it, and Open puts it back in /compose", async () => {
    addSend("s1", "uncertain", { rawBase64Url: raw });
    addSend("s2", "pending", { rawBase64Url: raw });

    await surfaceUnsentMessages();

    const current = useToastStore.getState().current;
    expect(current?.message).toBe(MAYBE_NOT_SENT);
    current?.action?.run();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/compose" }));
    expect(peekDraft()).toEqual({ accountId: "a", to: ["ana@x.com"], subject: "Plans", html: "<p>See you</p>", unsentId: "s1" });
    // The editor is memory only: the stored copy stays until the message is sent or discarded.
    expect(rows()).toEqual(["s1", "s2"]);
  });

  it("a reply a quit cut short keeps only its own notice: its send row goes, so nothing shows it again once it is reopened", async () => {
    addSend("r1", "failed", { rawBase64Url: raw, threadId: "t1", replyId: "x" });
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES ('pending_reply:x', ?)")
      .run(JSON.stringify({ id: "x", accountId: "a", threadId: "t1", status: "sending", scheduledAt: 1 }));
    await surfaceUnsentMessages();
    expect(rows()).toEqual([]);

    // The reply notice's Open takes the saved reply into its box: nothing is left to show.
    sqlite.exec("DELETE FROM settings");
    resetUnsentMessages();
    await surfaceUnsentMessages();
    expect(useToastStore.getState().current).toBeNull();
  });

  it("leaves a reply still saved as one to its own notice, and shows a notice once per session", async () => {
    addSend("r1", "failed", { rawBase64Url: raw, threadId: "t1", replyId: "x" });
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES ('pending_reply:x', ?)")
      .run(JSON.stringify({ id: "x", accountId: "a", threadId: "t1", status: "sending", scheduledAt: 1 }));
    await surfaceUnsentMessages();
    expect(useToastStore.getState().current).toBeNull();

    addSend("s1", "uncertain", { rawBase64Url: raw });
    await surfaceUnsentMessages();
    expect(useToastStore.getState().current?.message).toBe(MAYBE_NOT_SENT);
    useToastStore.setState({ current: null });
    await surfaceUnsentMessages();
    expect(useToastStore.getState().current).toBeNull();
  });

  it("a send the provider refused says it was not sent", async () => {
    addSend("s1", "failed", { rawBase64Url: raw });
    await surfaceUnsentMessages();
    expect(useToastStore.getState().current?.message).toBe(NOT_SENT);
  });

  it("a failed reply the queue kept reopens in its conversation, threaded, with Cc apart", async () => {
    const reply = buildRawEmail({ from: "me@home.com", to: ["ana@x.com"], cc: ["bia@x.com"], subject: "Re: Plans", htmlBody: "<p>Yes</p>", inReplyTo: "<m1@x>", references: "<m1@x>" });
    addSend("r1", "uncertain", { rawBase64Url: reply, threadId: "t1" });
    await surfaceUnsentMessages();
    useToastStore.getState().current?.action?.run();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t1" } }));
    const { takeReopenedReply } = await import("@/voa/thread/replySend");
    expect(takeReopenedReply("a", "t1")).toMatchObject({ mode: "replyAll", to: ["ana@x.com"], cc: ["bia@x.com"], inReplyTo: "<m1@x>", references: "<m1@x>", html: "<p>Yes</p>" });
    expect(peekDraft()).toBeNull();
    expect(rows()).toEqual([]);
  });

  it("two replies in one thread: the saved one's notice removes only its own send row, the other is shown", async () => {
    addSend("r-saved", "uncertain", { rawBase64Url: raw, threadId: "t1", replyId: "x" });
    addSend("r-offline", "uncertain", { rawBase64Url: raw, threadId: "t1" }, 2);
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES ('pending_reply:x', ?)")
      .run(JSON.stringify({ id: "x", accountId: "a", threadId: "t1", status: "sending", scheduledAt: 1 }));
    await surfaceUnsentMessages();
    expect(rows()).toEqual(["r-offline"]);
    expect(useToastStore.getState().current?.message).toBe(MAYBE_NOT_SENT);
  });
});
