import { useEffect, useState } from "react";
import { demoAI } from "./demo";
import type { DbMessage } from "@/services/db/messages";
import { getDb } from "@/services/db/connection";
import { getSetting } from "@/services/db/settings";
import { mailText, type MailText } from "./mailText";

/**
 * Apple's on-device model (Apple Intelligence), through the voa-ai bridge: one task asked of one
 * message, the answer checked by the task and kept in ai_cache. Tasks live in ./tasks.
 */

/** The shape of an answer, as the bridge reads it (src-tauri/ai/main.swift). Properties in the order the model fills them. */
export type Shape =
  | { type: "string" | "boolean" | "integer"; name?: string; description?: string; optional?: boolean }
  | { type: "array"; items: Shape; maxItems?: number; name?: string; description?: string; optional?: boolean }
  | { type: "object"; properties: Shape[]; name?: string; description?: string; optional?: boolean };

/** One use of the model: what to ask, in what shape, and how the answer is checked against the mail. */
export type Task<T> = {
  /** With `version`, the cache key: bump the version when the instructions, the shape or the check change. */
  id: string;
  version: number;
  instructions: string;
  schema: Shape;
  /** The answer kept only where the mail bears it out; null when there is nothing to show. */
  check: (answer: unknown, mail: MailText) => T | null;
  /** Writes for the owner (the summary), so it also follows their own note (Settings > Summary, AI_NOTE). A flight's facts and a reply do not. */
  personal?: boolean;
};

/** The settings row of the owner's note on how to summarize, read by every personal task. */
export const AI_NOTE = "ai_note";
/** The note until the owner saves their own (an empty one saved stays empty). */
export const DEFAULT_AI_NOTE = "Always summarize in English";

/** The owner's instructions, as every personal task and Settings read them. */
export async function ownInstructions(): Promise<string> {
  return ((await getSetting(AI_NOTE)) ?? DEFAULT_AI_NOTE).trim();
}

/** What a task is asked of: the row its answer is kept under, and the text the model reads. */
export type Subject = { id: string; account_id: string; thread_id: string; read: () => MailText };

export type Mail = Pick<DbMessage, "id" | "account_id" | "thread_id" | "body_html" | "body_text">;

/** One message as a subject: its own text. */
export const ofMessage = (m: Mail): Subject => ({ id: m.id, account_id: m.account_id, thread_id: m.thread_id, read: () => mailText(m.body_html, m.body_text) });

/** The shape with the owner's note on every field the model writes text in (a string, a list of them). */
function withNote(shape: Shape, note: string): Shape {
  const say = (d?: string) => `${d ? `${d}. ` : ""}Follow the reader's instructions: ${note}`;
  if (shape.type === "object") return { ...shape, properties: shape.properties.map((p) => withNote(p, note)) };
  if (shape.type === "array") return { ...shape, description: say(shape.description), items: withNote(shape.items, note) };
  return shape.type === "string" ? { ...shape, description: say(shape.description) } : shape;
}

/** A short, stable tag of a text (FNV-1a), so a changed note gets a new cache key. */
function tag(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

const inFlight = new Map<string, Promise<unknown>>();
let queue: Promise<unknown> = Promise.resolve();

/** Runs after whatever the model is busy with: one question at a time on this Mac. */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(job);
  queue = next;
  return next;
}

/**
 * What `task` finds in `subject`: from ai_cache, or asked now. Null when nothing; undefined when it
 * could not be asked (no model on this Mac), and then nothing is stored, so it is asked again
 * another time. One question at a time to the model (it runs on this Mac), and one per key.
 */
export async function ask<T>(task: Task<T>, subject: Subject): Promise<T | null | undefined> {
  if (demoAI.ask) return (await demoAI.ask(task.id, subject)) as T | null;
  const { note, key } = await keyOf(task, subject);
  let p = inFlight.get(key) as Promise<T | null | undefined> | undefined;
  if (!p) {
    p = cached<T>(subject, key).then(
      (hit) => (hit !== undefined ? hit : queued(() => fresh(task, subject, key, note))) as Promise<T | null | undefined>,
    );
    p = p.finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

/** The cache key of a task asked of a subject: its version and, for a personal task, the owner's note. */
async function keyOf(task: Task<unknown>, subject: Subject): Promise<{ note: string; key: string }> {
  const note = task.personal ? await ownInstructions() : "";
  return { note, key: `${task.id}/${task.version}${note ? `/${tag(note)}` : ""}:${subject.id}` };
}

/** What `task` already found in `subject`, without asking the model: undefined when it was never asked. */
export async function known<T>(task: Task<T>, subject: Subject): Promise<T | null | undefined> {
  return cached<T>(subject, (await keyOf(task, subject)).key);
}

async function cached<T>(s: Subject, key: string): Promise<T | null | undefined> {
  const db = await getDb();
  const rows = await db.select<{ content: string }[]>("SELECT content FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3", [
    s.account_id,
    s.thread_id,
    key,
  ]);
  return rows[0] ? (JSON.parse(rows[0].content) as T | null) : undefined;
}

/**
 * One question to the model: the task's instructions with the owner's note first (when there is one)
 * and on every field it writes, then the check. Undefined when the Mac has no model; throws when the
 * call fails twice.
 */
async function call<T>(task: Task<T>, mail: MailText, note: string): Promise<T | null | undefined> {
  // First, as what wins over the rest, and again on every field the model writes: at the end of the
  // instructions it left "write in Portuguese" unread, and first alone it still wrote one English mail in English.
  const instructions = note
    ? `The reader's own instructions come before anything else here, and win over it:\n${note}\n\n${task.instructions}`
    : task.instructions;
  const schema = note ? withNote(task.schema, note) : task.schema;
  const { invoke } = await import("@tauri-apps/api/core");
  const request = JSON.stringify({ instructions, schema, input: mail.text });
  // Once more on a failure: the model now and then refuses a call at once and takes the same one next.
  const raw = await invoke<string>("ai_ask", { request }).catch(() => invoke<string>("ai_ask", { request }));
  const answer = JSON.parse(raw) as unknown;
  if ((answer as { unavailable?: boolean }).unavailable) return undefined;
  // What fails the same way every time (too long, a language it does not read, a refusal that text did not get past): nothing.
  if ((answer as { failed?: boolean }).failed) return null;
  return task.check(answer, mail);
}

/**
 * Asked now and stored, nothing included, so no pass asks it again (a new version does). A call that
 * fails (throws) stores nothing: those pass (the model busy, refusing at once and answering next), so it is asked again.
 */
async function fresh<T>(task: Task<T>, s: Subject, key: string, note: string): Promise<T | null | undefined> {
  const found = await call(task, s.read(), note);
  if (found === undefined) return undefined;
  const db = await getDb();
  await db.execute("INSERT OR REPLACE INTO ai_cache (id, account_id, thread_id, type, content) VALUES ($1, $2, $3, $4, $5)", [
    `${s.account_id}:${key}`,
    s.account_id,
    s.thread_id,
    key,
    JSON.stringify(found),
  ]);
  return found;
}

/** What `task` finds in a message the reader shows (when `enabled`), from the cache or asked now. */
export function useTask<T>(task: Task<T>, message: DbMessage, enabled: boolean): T | null {
  const [found, setFound] = useState<T | null>(null);
  const ready = enabled && message.body_pending !== 1 && (message.body_html != null || message.body_text != null);
  useEffect(() => {
    if (!ready || !("__TAURI_INTERNALS__" in window || demoAI.ask)) return;
    let live = true;
    ask(task, ofMessage(message))
      .then((t) => live && setFound(t ?? null))
      .catch((err: unknown) => console.warn(`ai ${task.id} failed`, err));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, ready, message.id, message.body_html, message.body_text]);
  return found;
}

let passing = false;

/**
 * Asks `tasks` of every inbox message they have not seen yet (newest first), one at a time, so
 * a card is ready before the mail is opened. Runs after each sync; a pass already running is left alone.
 * ponytail: bounded by the inbox itself, which an inbox-zero owner keeps short.
 */
export async function readAhead(tasks: Task<unknown>[]): Promise<void> {
  if (passing) return;
  passing = true;
  try {
    const db = await getDb();
    for (const task of tasks) {
      const key = `${task.id}/${task.version}:`;
      const todo = await db.select<Mail[]>(
        `SELECT m.id, m.account_id, m.thread_id, m.body_html, m.body_text FROM messages m
         JOIN thread_labels tl ON tl.account_id = m.account_id AND tl.thread_id = m.thread_id AND tl.label_id = 'INBOX'
         WHERE m.body_pending = 0 AND (m.body_html IS NOT NULL OR m.body_text IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM ai_cache c WHERE c.account_id = m.account_id AND c.thread_id = m.thread_id AND c.type = $1 || m.id)
         ORDER BY m.date DESC`,
        [key],
      );
      for (const m of todo) {
        const found = await ask(task, ofMessage(m)).catch((err: unknown) => {
          console.warn(`ai ${task.id} failed`, err);
          return null; // asked again next sync
        });
        if (found === undefined) return; // no model on this Mac: stop until the next sync
      }
    }
  } finally {
    passing = false;
  }
}
