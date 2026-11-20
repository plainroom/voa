/** Test-only: the inbox's tables on an in-memory node:sqlite, behind the shape getDb() returns. */
import type { DatabaseSync } from "node:sqlite";
import type { getDb } from "@/services/db/connection";
import { screen, waitFor } from "@testing-library/react";

export async function createInboxDb(): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, color TEXT, provider TEXT DEFAULT 'gmail_api',
      is_active INTEGER DEFAULT 1, history_id TEXT, access_token TEXT, refresh_token TEXT, imap_password TEXT, created_at INTEGER);
    CREATE TABLE threads (id TEXT NOT NULL, account_id TEXT NOT NULL, subject TEXT, snippet TEXT,
      last_message_at INTEGER, message_count INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0, is_important INTEGER DEFAULT 0, has_attachments INTEGER DEFAULT 0,
      is_snoozed INTEGER DEFAULT 0, snooze_until INTEGER, is_pinned INTEGER DEFAULT 0,
      is_muted INTEGER DEFAULT 0, PRIMARY KEY (account_id, id));
    CREATE TABLE thread_labels (thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL,
      PRIMARY KEY (account_id, thread_id, label_id));
    CREATE TABLE messages (id TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      from_name TEXT, from_address TEXT, date INTEGER NOT NULL, body_text TEXT, body_html TEXT, message_id_header TEXT);
    CREATE TABLE blocked_senders (account_id TEXT NOT NULL, address TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (account_id, address));
    CREATE TABLE blocked_messages (account_id TEXT NOT NULL, address TEXT NOT NULL, message_id_header TEXT NOT NULL,
      PRIMARY KEY (account_id, address, message_id_header));
    CREATE TABLE pending_operations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, operation_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 10, next_retry_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()), error_message TEXT);
    INSERT INTO accounts (id, email, display_name, color, created_at, history_id) VALUES ('a', 'me@home.com', 'Personal', 'account-1', 1, '100');
    INSERT INTO accounts (id, email, display_name, color, created_at, history_id) VALUES ('b', 'me@work.com', 'Work', 'account-2', 2, '100');
  `);
  return sqlite;
}

export function asDb(sqlite: DatabaseSync): Awaited<ReturnType<typeof getDb>> {
  const toQmark = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
  return {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(toQmark(sql)).all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) => {
      const r = sqlite.prepare(toQmark(sql)).run(...(params as never[]));
      return { rowsAffected: Number(r.changes) };
    },
  } as unknown as Awaited<ReturnType<typeof getDb>>;
}

export function seed(sqlite: DatabaseSync, accountId: string, id: string, at: number, labels: string[], snoozeUntil?: number) {
  sqlite
    .prepare("INSERT INTO threads (id, account_id, subject, last_message_at, is_snoozed, snooze_until, is_starred) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, accountId, `S ${id}`, at, snoozeUntil ? 1 : 0, snoozeUntil ?? null, labels.includes("STARRED") ? 1 : 0);
  sqlite
    .prepare("INSERT INTO messages (id, account_id, thread_id, from_name, date) VALUES (?, ?, ?, ?, ?)")
    .run(`m-${accountId}-${id}`, accountId, id, "Sender", at);
  for (const l of labels) {
    sqlite.prepare("INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES (?, ?, ?)").run(id, accountId, l);
  }
}

/**
 * The row's text, once the screen has also selected that row. The list shows before the selection effect lands, and a
 * key pressed in between acts on nothing: wait for the state a user would see before the first key.
 */
export async function findSelectedRow(text: string) {
  const el = await screen.findByText(text);
  await waitFor(() => expect(el.closest('[role="row"]')?.getAttribute("aria-selected")).toBe("true"));
  return el;
}
