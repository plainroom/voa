import { sendEmail } from "@/services/emailActions";
import { upsertContact } from "@/services/db/contacts";
import { getDb } from "@/services/db/connection";
import { useComposerStore } from "@/stores/composerStore";
import { useToastStore } from "@/voa/ui/Toast";
import type { ReplyMode } from "./replyAddressing";

export const SEND_FAILED = "Couldn't send your reply.";
export const NOT_SENT = "A reply wasn't sent";
export const MAYBE_SENT = "A reply may not have been sent. Check Sent first.";

/** A reply on its way: the raw message, and what the owner wrote, kept to reopen it if it is not sent. */
export interface OutgoingReply {
  accountId: string;
  threadId: string;
  mode: ReplyMode;
  raw: string;
  to: string[];
  cc: string[];
  subject: string;
  /** What the owner typed (no signature): what comes back in the reply box. */
  html: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * What survives the app quitting: one settings row per reply, written when it is scheduled and deleted
 * only once it is sent, undone or back in its reply box. Never sent from here: a row may be a reply
 * Gmail already has (the app quit between the send and the delete), so at startup it is only shown.
 */
export interface SavedReply extends Omit<OutgoingReply, "raw"> {
  id: string;
  scheduledAt: number;
  /** `sending`: the send started, so it may have gone. */
  status: "scheduled" | "sending" | "failed";
}

const KEY = "pending_reply:";

/** Writes for one reply run in order, so a delete never lands before its insert. */
const chains = new Map<string, Promise<void>>();
function persist(id: string, op: () => Promise<unknown>): Promise<void> {
  const next = (chains.get(id) ?? Promise.resolve()).then(op).then(
    () => {},
    (err) => console.error("voa could not save the pending reply:", err),
  );
  chains.set(id, next);
  void next.then(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
  return next;
}

const save = (r: SavedReply) =>
  persist(r.id, async () =>
    (await getDb()).execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
      [KEY + r.id, JSON.stringify(r)],
    ),
  );
const forget = (id: string) =>
  persist(id, async () =>
    (await getDb()).execute("DELETE FROM settings WHERE key = $1", [KEY + id]),
  );

/** Saves a reply rebuilt from elsewhere (a failed send the queue kept), so it follows the reply's own life. */
export const keepReply = (r: SavedReply): Promise<void> => save(r);

export async function savedReplies(): Promise<SavedReply[]> {
  const rows = await (
    await getDb()
  ).select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key LIKE $1",
    [`${KEY}%`],
  );
  return rows.flatMap((r) => {
    try {
      return [JSON.parse(r.value) as SavedReply];
    } catch {
      return [];
    }
  });
}

/** Replies this session is holding (waiting, sending, or reopened and not yet in their box): not "unsent". */
const live = new Set<string>();

/** Sends now. A failure keeps the reply saved and says so, with Open putting it back in its reply box. */
async function deliver(saved: SavedReply, raw: string): Promise<void> {
  live.add(saved.id);
  // Marked before the send: a quit mid-send then reads "may not have been sent", never "wasn't sent".
  const sending = { ...saved, status: "sending" as const };
  await save(sending);
  try {
    const result = await sendEmail(saved.accountId, raw, saved.threadId, saved.id);
    if (result.uncertain) {
      // It may have gone: the row stays `sending` (shown as "may not have been sent") and nothing sends it again.
      live.delete(saved.id);
      useToastStore.getState().showAction(MAYBE_SENT, "Open", () => reopenReply(sending));
      return;
    }
    if (!result.success) throw new Error(result.error ?? "Send failed");
  } catch (err) {
    console.error("voa could not send the reply:", err);
    const failed = { ...sending, status: "failed" as const };
    await save(failed);
    live.delete(saved.id);
    useToastStore
      .getState()
      .showAction(SEND_FAILED, "Open", () => reopenReply(failed));
    return;
  }
  await forget(saved.id);
  live.delete(saved.id);
  for (const address of [...saved.to, ...saved.cc])
    await upsertContact(address, null).catch(() => {});
}

interface Pending {
  saved: SavedReply;
  raw: string;
  timer: ReturnType<typeof setTimeout>;
  /** Undo: the reply goes back where it was written. */
  restore: (reply: SavedReply) => void;
}

let pending: Pending | null = null;

function settle(): Pending | null {
  const p = pending;
  pending = null;
  if (p) clearTimeout(p.timer);
  const store = useComposerStore.getState();
  store.setUndoSendTimer(null);
  store.setUndoSendVisible(false);
  return p;
}

/**
 * Saves `reply` at once and sends it after `delayMs`, while the "Sending..." toast offers Undo. A reply
 * still waiting when another is scheduled or its screen closes is sent at once; one the app quits on stays
 * saved and is shown at the next start.
 */
export function scheduleReply(
  reply: OutgoingReply,
  delayMs: number,
  restore: (reply: SavedReply) => void,
): Promise<void> {
  flushPendingReply();
  const { raw, ...rest } = reply;
  const saved: SavedReply = {
    ...rest,
    id: crypto.randomUUID(),
    scheduledAt: Date.now() + delayMs,
    status: "scheduled",
  };
  live.add(saved.id);
  const written = save(saved);
  const timer = setTimeout(() => {
    const p = settle();
    if (p) void deliver(p.saved, p.raw);
  }, delayMs);
  pending = { saved, raw, timer, restore };
  const store = useComposerStore.getState();
  store.setUndoSendTimer(timer);
  store.setUndoSendVisible(true);
  return written;
}

/** Sends the waiting reply now (its screen is going away). */
export function flushPendingReply(): Promise<void> | undefined {
  const p = settle();
  return p ? deliver(p.saved, p.raw) : undefined;
}

/** Undo: nothing is sent and the reply goes back to its editor. */
export function cancelPendingReply(): Promise<void> | undefined {
  const p = settle();
  if (!p) return;
  live.delete(p.saved.id);
  p.restore(p.saved);
  // A restore that had to reopen the conversation (its box was gone) keeps the row until the box takes it.
  return live.has(p.saved.id) ? undefined : forget(p.saved.id);
}

export const hasPendingReply = () => pending !== null;

// --- Reopening a reply in its conversation's reply box ---

const reopened = new Map<string, SavedReply>();
const slot = (accountId: string, threadId: string) =>
  `${accountId}:${threadId}`;
export const REOPEN_EVENT = "voa-reopen-reply";

/** Opens the reply's conversation with the reply back in its box (Undo with the box gone, Open on a toast). */
export function reopenReply(reply: SavedReply): void {
  live.add(reply.id);
  reopened.set(slot(reply.accountId, reply.threadId), reply);
  window.dispatchEvent(new Event(REOPEN_EVENT));
  void import("@/router").then(({ router }) =>
    router.navigate({
      to: "/t/$accountId/$threadId",
      params: { accountId: reply.accountId, threadId: reply.threadId },
    }),
  );
}

/** The reply box of a conversation takes its reopened reply; it is in the editor now, so no longer saved. */
export function takeReopenedReply(
  accountId: string,
  threadId: string,
): SavedReply | null {
  const key = slot(accountId, threadId);
  const reply = reopened.get(key);
  if (!reply) return null;
  reopened.delete(key);
  live.delete(reply.id);
  void forget(reply.id);
  return reply;
}

/**
 * At startup: a reply the app quit on (or that failed) is shown, never sent, since it may already
 * have gone. Open puts it back in its reply box; the next one is shown after that.
 */
export async function surfaceUnsentReplies(
  accountIds: string[],
): Promise<void> {
  const all = await savedReplies().catch((err) => {
    console.error("voa could not read pending replies:", err);
    return [];
  });
  // A removed account's reply has nowhere to go back to.
  for (const r of all.filter((r) => !accountIds.includes(r.accountId)))
    void forget(r.id);
  const left = all
    .filter((r) => accountIds.includes(r.accountId) && !live.has(r.id))
    .sort((a, b) => b.scheduledAt - a.scheduledAt);
  const next = left[0];
  if (!next) return;
  const message = next.status === "sending" ? MAYBE_SENT : NOT_SENT;
  useToastStore
    .getState()
    .showAction(
      left.length > 1 ? `${message} (${left.length})` : message,
      "Open",
      () => {
        reopenReply(next);
        void surfaceUnsentReplies(accountIds);
      },
    );
}

/** Test-only: forget this session's in-memory state. */
export function resetReplySend(): void {
  settle();
  live.clear();
  reopened.clear();
}
