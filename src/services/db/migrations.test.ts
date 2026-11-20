import type { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi, beforeEach } from "vitest";

let sqlite: DatabaseSync;
const executed: string[] = [];
vi.mock("./connection", () => ({
  getDb: async () => ({
    select: async (sql: string) => sqlite.prepare(sql).all(),
    execute: async (sql: string, params: unknown[] = []) => {
      executed.push(sql);
      if (params.length === 0) {
        sqlite.exec(sql);
        return { rowsAffected: 0 };
      }
      const r = sqlite.prepare(sql.replace(/\$(\d+)/g, "?$1")).run(...(params as never[]));
      return { rowsAffected: Number(r.changes) };
    },
  }),
}));

const { addedColumn, migrationBatch, runMigrations, splitStatements } = await import("./migrations");

describe("splitStatements", () => {
  it("keeps a semicolon inside a string", () => {
    expect(splitStatements("UPDATE t SET a = replace(a, '&#39;', ''''); SELECT 1;")).toEqual([
      "UPDATE t SET a = replace(a, '&#39;', '''')",
      "SELECT 1",
    ]);
  });

  it("splits simple statements", () => {
    const result = splitStatements("CREATE TABLE foo (id INT); CREATE TABLE bar (id INT);");
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("CREATE TABLE foo (id INT)");
    expect(result[1]).toBe("CREATE TABLE bar (id INT)");
  });

  it("keeps trigger body intact", () => {
    const sql = `
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, subject) VALUES (new.rowid, new.subject);
      END;
    `;
    const result = splitStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("BEGIN");
    expect(result[0]).toContain("END");
    expect(result[0]).toContain("INSERT INTO messages_fts");
  });

  it("handles multiple triggers", () => {
    const sql = `
      CREATE TABLE foo (id INT);

      CREATE TRIGGER t1 AFTER INSERT ON foo BEGIN
        INSERT INTO bar VALUES (new.id);
      END;

      CREATE TRIGGER t2 AFTER DELETE ON foo BEGIN
        DELETE FROM bar WHERE id = old.id;
      END;
    `;
    const result = splitStatements(sql);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("CREATE TABLE");
    expect(result[1]).toContain("CREATE TRIGGER t1");
    expect(result[2]).toContain("CREATE TRIGGER t2");
  });

  it("handles trigger with multiple statements inside BEGIN...END", () => {
    const sql = `
      CREATE TRIGGER t1 AFTER UPDATE ON messages BEGIN
        INSERT INTO fts(fts, rowid, subject) VALUES ('delete', old.rowid, old.subject);
        INSERT INTO fts(rowid, subject) VALUES (new.rowid, new.subject);
      END;
    `;
    const result = splitStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("BEGIN");
    expect(result[0]).toContain("END");
  });

  it("handles empty input", () => {
    expect(splitStatements("")).toHaveLength(0);
    expect(splitStatements("   ")).toHaveLength(0);
  });

  it("does not match END inside words like BACKEND", () => {
    const sql = "CREATE TABLE backend (id INT); CREATE TABLE foo (id INT);";
    const result = splitStatements(sql);
    expect(result).toHaveLength(2);
  });
});

describe("migrationBatch", () => {
  it("sends BEGIN, the statements, the version row and COMMIT as one text", () => {
    const sql = migrationBatch(7, "Bob's table", ["CREATE TABLE t (id INT) -- note", "-- only a comment"], () => false);
    expect(sql.startsWith("BEGIN\n;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT\n;")).toBe(true);
    expect(sql).toContain("CREATE TABLE t (id INT) -- note\n;");
    expect(sql).not.toContain("only a comment");
    expect(sql).toContain("VALUES (7, 'Bob''s table')");
  });

  it("leaves out a column that already exists", () => {
    const statements = ["ALTER TABLE accounts ADD COLUMN color TEXT", "ALTER TABLE accounts ADD COLUMN other TEXT"];
    const sql = migrationBatch(1, "x", statements, (table, column) => table === "accounts" && column === "color");
    expect(sql).not.toContain("color");
    expect(sql).toContain("ADD COLUMN other");
  });

  it("reads the table and column an ADD COLUMN adds", () => {
    expect(addedColumn("-- why\nALTER TABLE threads ADD COLUMN is_muted INTEGER DEFAULT 0")).toEqual({ table: "threads", column: "is_muted" });
    expect(addedColumn("CREATE TABLE x (id INT)")).toBeNull();
  });
});

describe("runMigrations", () => {
  beforeEach(async () => {
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(":memory:");
    executed.length = 0;
  });

  it("applies every migration with no BEGIN or COMMIT sent apart and leaves no transaction open", async () => {
    await runMigrations();
    expect(executed.some((sql) => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql))).toBe(false);
    expect(sqlite.isTransaction).toBe(false);
    const versions = sqlite.prepare("SELECT version FROM _migrations ORDER BY version").all().map((r) => r.version);
    expect(versions.length).toBeGreaterThan(20);
    expect(versions[0]).toBe(1);
  });

  it("finishes a migration applied in part without failing on its columns", async () => {
    await runMigrations();
    sqlite.exec("DELETE FROM _migrations WHERE version = 24");
    await runMigrations();
    expect(sqlite.prepare("SELECT 1 FROM _migrations WHERE version = 24").all()).toHaveLength(1);
    expect(sqlite.isTransaction).toBe(false);
  });
});
