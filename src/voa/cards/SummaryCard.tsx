import { CornerDownRight, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import type { DbMessage } from "@/services/db/messages";
import { ask } from "../ai/apple";
import { conversation, summary, type Summary } from "../ai/tasks/summary";

type State = { summary: Summary } | "reading" | "unavailable" | "none";

/** The summary over a conversation: one sentence, its main points, and what it asks of the reader. */
export function SummaryCard({ state }: { state: State }) {
  return (
    <section aria-label="Summary" className="mb-4 rounded-panel bg-trip px-5 py-4">
      <p className="flex items-center gap-1.5 text-meta font-medium text-ink-2">
        <ScrollText size={12} strokeWidth={1.75} /> Summary
      </p>
      {state === "reading" ? (
        <p className="mt-2 animate-pulse text-body text-ink-3">Summarizing…</p>
      ) : state === "unavailable" ? (
        <p className="mt-2 text-body text-ink-3">Apple Intelligence is not available on this Mac.</p>
      ) : state === "none" ? (
        <p className="mt-2 text-body text-ink-3">Could not summarize this conversation.</p>
      ) : (
        <>
          {state.summary.gist && <p className="mt-2 text-title font-medium text-ink">{state.summary.gist}</p>}
          {state.summary.points.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {state.summary.points.map((p, i) => (
                <li key={i} className="flex gap-2.5 text-body text-ink-2">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {state.summary.action && (
            <p className="mt-3 flex gap-2 border-t border-line pt-3 text-body font-medium text-ink">
              <CornerDownRight size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-2" />
              {state.summary.action}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The summary of these messages, asked when shown (Summarize, I) and kept: a new message asks again. */
export function ConversationSummary({ messages }: { messages: DbMessage[] }) {
  const [state, setState] = useState<State>("reading");
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!lastId) return;
    let live = true;
    setState("reading");
    ask(summary, conversation(messages))
      .then((s) => live && setState(s === undefined ? "unavailable" : s ? { summary: s } : "none"))
      .catch((err: unknown) => {
        console.warn("summary failed", err);
        if (live) setState("none");
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);
  return <SummaryCard state={state} />;
}
