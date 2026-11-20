import type { DbMessage } from "@/services/db/messages";
import type { Shape, Subject, Task } from "../apple";
import { MAX, mailText } from "../mailText";

/** A conversation in a few lines: what it is about, its main points, and what it asks of the reader, if anything. */
export type Summary = { gist: string; points: string[]; action: string };

type Raw = { gist?: unknown; points?: unknown; asks?: unknown; action?: unknown };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Unlike a flight, a summary cannot be checked against the mail line by line: it is asked only when
 * the owner presses Summarize, and reads as a guide, not a source. Only its shape is checked.
 */
export function checkSummary(answer: unknown): Summary | null {
  if (!answer || typeof answer !== "object") return null;
  const raw = answer as Raw;
  const gist = str(raw.gist);
  const points = (Array.isArray(raw.points) ? raw.points.map(str).filter(Boolean) : []).slice(0, 5);
  if (!gist && !points.length) return null;
  return { gist, points, action: raw.asks === true ? str(raw.action) : "" };
}

const shape = (type: "string" | "boolean", name: string, description: string, optional = false): Shape => ({ type, name, description, optional });

export const summary: Task<Summary> = {
  id: "summary",
  version: 3,
  personal: true,
  instructions:
    "You summarize an email conversation for the person who received it: rich and easy to read, faithful to the emails, saying nothing they do not say. Write in the language of the emails unless the reader's instructions ask for another.",
  schema: {
    type: "object",
    properties: [
      shape("string", "gist", "One sentence saying what the conversation is about"),
      { type: "array", name: "points", description: "3 to 5 main points, each a short, concrete sentence", maxItems: 5, items: { type: "string" } },
      shape(
        "boolean",
        "asks",
        "True only if the emails ask something of the reader (to reply, pay, confirm, send something); false for articles, newsletters and notices",
      ),
      shape("string", "action", "When asks: what the reader has to do, in one sentence", true),
    ],
  },
  check: checkSummary,
};

/**
 * A conversation as the summary reads it: every message, oldest first, each without what it quotes
 * of the ones before, under who sent it. The model reads up to its context from the end, so the
 * newest messages (a reply that settles something) are never the ones cut.
 */
export function conversation(messages: DbMessage[]): Subject {
  const last = messages[messages.length - 1]!; // a conversation has a message
  return {
    id: last.id,
    account_id: last.account_id,
    thread_id: last.thread_id,
    read: () => {
      const text = messages.map((m) => `${m.from_name || m.from_address || "Someone"}: ${mailText(m.body_html, m.body_text, true).text}`).join("\n\n");
      return { text: text.slice(-MAX), links: [] };
    },
  };
}
