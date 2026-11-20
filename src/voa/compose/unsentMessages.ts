import {
  deleteOperation,
  getFailedSends,
  type PendingOperation,
} from "@/services/db/pendingOperations";
import { keepReply, reopenReply, savedReplies, type SavedReply } from "@/voa/thread/replySend";
import { parseRawEmail } from "@/utils/emailBuilder";
import { useToastStore } from "../ui/Toast";
import { stashDraft } from "./draftStash";

export const MAYBE_NOT_SENT = "A message may not have been sent. Check Sent.";
/** The provider refused it: it did not go. */
export const NOT_SENT = "Couldn't send a message.";

/** Shown once per session: a notice the owner let fade is not repeated on every queue pass. */
const shown = new Set<string>();

/** The saved reply this send row is, when the reply recorded it. Never guessed from the thread: two replies can share one. */
const replyIdOf = (op: PendingOperation): string | null => {
  try {
    return (JSON.parse(op.params) as { replyId?: string }).replyId ?? null;
  } catch {
    return null;
  }
};

/** The toast is one at a time: wait for the one on screen (e.g. an unsent reply) to go. */
function whenToastFree(): Promise<void> {
  return new Promise((resolve) => {
    if (!useToastStore.getState().current) return resolve();
    const off = useToastStore.subscribe((s) => {
      if (s.current) return;
      off();
      resolve();
    });
  });
}

/**
 * A reply goes back to its conversation's reply box as a saved reply (To and Cc apart, threaded as it was written); a
 * new message goes back to /compose.
 */
async function reopen(op: PendingOperation): Promise<void> {
  const { rawBase64Url, threadId } = JSON.parse(op.params) as { rawBase64Url: string; threadId?: string };
  const parsed = parseRawEmail(rawBase64Url);
  if (threadId) {
    const { cc, inReplyTo, references, ...rest } = parsed;
    const reply: SavedReply = {
      ...rest,
      cc,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
      id: op.id,
      accountId: op.account_id,
      threadId,
      mode: parsed.subject.startsWith("Fwd:") ? "forward" : cc.length > 0 ? "replyAll" : "reply",
      scheduledAt: op.created_at * 1000,
      status: op.status === "failed" ? "failed" : "sending",
    };
    await keepReply(reply);
    await deleteOperation(op.id);
    reopenReply(reply);
    return;
  }
  // The row stays: the editor is memory only, so the stored copy goes once the message is sent or discarded.
  stashDraft({ accountId: op.account_id, to: parsed.to, subject: parsed.subject, html: parsed.html, unsentId: op.id });
  const { router } = await import("@/router");
  await router.navigate({ to: "/compose" });
}

function show(left: readonly PendingOperation[]): void {
  const [next, ...rest] = left;
  if (!next) return;
  const message = next.status === "failed" ? NOT_SENT : MAYBE_NOT_SENT;
  useToastStore
    .getState()
    .showAction(
      left.length > 1 ? `${message} (${left.length})` : message,
      "Open",
      () => {
        void reopen(next).catch((err) =>
          console.error("voa could not reopen the message:", err),
        );
        show(rest);
      },
    );
}

/**
 * A send that ended failed (refused, cut short by a quit, or whose outcome is unknown) is shown, never sent again: it
 * may already have gone. Open reopens the message in /compose. A reply still saved as one has its own notice, which
 * reopens it in its conversation: its own send row (the same reply id) goes, so it never gets a second notice or a
 * third copy. Another reply's row in the same thread stays and is shown.
 */
export async function surfaceUnsentMessages(): Promise<void> {
  const [ops, replies] = await Promise.all([
    getFailedSends(),
    savedReplies().catch(() => []),
  ]);
  const kept = new Set(replies.map((r) => r.id));
  const left: PendingOperation[] = [];
  for (const op of ops) {
    const replyId = replyIdOf(op);
    if (replyId && kept.has(replyId)) await deleteOperation(op.id);
    else if (!shown.has(op.id)) left.push(op);
  }
  if (left.length === 0) return;
  for (const op of left) shown.add(op.id);
  await whenToastFree();
  show(left);
}

/** The message reopened from `id` was sent again or discarded: its stored copy goes. */
export const forgetUnsentMessage = (id: string): Promise<void> => deleteOperation(id);

/** Test-only: forget what this session showed. */
export const resetUnsentMessages = () => shown.clear();
