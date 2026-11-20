import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:voa.db");
  }
  return db;
}

/**
 * Runs a batch of writes after the batches queued before it, one batch at a time.
 * It opens no SQL transaction: the plugin runs each execute on any connection of its
 * pool, so a BEGIN and a COMMIT sent apart can land on different connections and
 * leave a write lock open that blocks every later write. What it holds (IMAP sync's
 * thread, message and label upserts) is written again by the next sync if a batch fails.
 */
let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(fn: (db: Database) => Promise<void>): Promise<void> {
  const prev = txQueue;
  let resolve!: () => void;
  txQueue = new Promise<void>((r) => {
    resolve = r;
  });

  try {
    await prev;
  } catch {
    // the previous batch failed: this one still runs
  }

  try {
    await fn(await getDb());
  } finally {
    resolve();
  }
}

/**
 * Execute a SELECT query and return the first result or null.
 */
export async function selectFirstBy<T>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const db = await getDb();
  const rows = await db.select<T[]>(query, params);
  return rows[0] ?? null;
}

