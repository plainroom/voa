import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

let sqlite: DatabaseSync;
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@/services/db/settings", () => ({ getSetting: async () => null }));
vi.mock("@/services/db/connection", () => ({
  getDb: async () => ({
    select: async (sql: string, params: unknown[] = []) =>
      sqlite
        .prepare(sql.replace(/\$(\d+)/g, "?$1"))
        .all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) =>
      sqlite
        .prepare(sql.replace(/\$(\d+)/g, "?$1"))
        .run(...(params as never[])),
  }),
}));

const { ask } = await import("./apple");

const task = {
  id: "t",
  version: 1,
  instructions: "",
  schema: { type: "string" as const },
  check: (a: unknown) => (typeof a === "string" ? a : null),
};
const subject = {
  id: "m1",
  account_id: "a",
  thread_id: "th",
  read: () => ({ text: "hi", links: [] }),
};
const stored = () =>
  sqlite
    .prepare("SELECT content FROM ai_cache")
    .all()
    .map((r) => r.content);

describe("ask", () => {
  beforeEach(async () => {
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      "CREATE TABLE ai_cache (id TEXT PRIMARY KEY, account_id TEXT, thread_id TEXT, type TEXT, content TEXT)",
    );
    invoke.mockReset();
  });

  it("keeps a failure that repeats as nothing, so it is not asked again", async () => {
    invoke.mockResolvedValue('{"failed": true}');
    expect(await ask(task, subject)).toBeNull();
    expect(stored()).toEqual(["null"]);
  });

  it("keeps nothing when the call fails, so the next pass asks again", async () => {
    invoke.mockRejectedValue(new Error("voa-ai: busy"));
    await expect(ask(task, subject)).rejects.toThrow("busy");
    expect(stored()).toEqual([]);
    invoke.mockResolvedValue('"news"');
    expect(await ask(task, subject)).toBe("news");
  });
});
