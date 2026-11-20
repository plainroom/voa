/**
 * Test-only: the app's real schema (every migration) on an in-memory node:sqlite. Mock `@tauri-apps/plugin-sql` so
 * `Database.load` returns `sqliteDb(() => sqlite)`, then `await migrate()` for each fresh database.
 */
import type { DatabaseSync } from "node:sqlite";
import type { getDb } from "./connection";

type Db = Awaited<ReturnType<typeof getDb>>;

/** getDb()'s shape over node:sqlite, read at each call. A text with no parameters may hold many statements. */
export function sqliteDb(current: () => DatabaseSync): Db {
  const toQmark = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
  return {
    select: async (sql: string, params: unknown[] = []) => current().prepare(toQmark(sql)).all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) => {
      if (params.length === 0) {
        current().exec(sql);
        return { rowsAffected: 0 };
      }
      const r = current().prepare(toQmark(sql)).run(...(params as never[]));
      return { rowsAffected: Number(r.changes) };
    },
  } as unknown as Db;
}

/** Runs every migration on the database getDb() returns. */
export async function migrate(): Promise<void> {
  const { runMigrations } = await import("./migrations");
  const log = console.log;
  console.log = () => {};
  try {
    await runMigrations();
  } finally {
    console.log = log;
  }
}
