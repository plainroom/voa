import { normalizeEmail } from "@/utils/emailUtils";
import { getDb } from "./connection";

/** Every address the account's owner sends as, normalized: the account itself and its aliases. */
export async function getOwnAddresses(accountId: string, accountEmail: string | null | undefined): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ email: string }[]>("SELECT email FROM send_as_aliases WHERE account_id = $1", [accountId]);
  const own = new Set(rows.map((row) => normalizeEmail(row.email)).filter(Boolean));
  if (accountEmail) own.add(normalizeEmail(accountEmail));
  return own;
}

/** Replaces the account's aliases with what the provider listed. */
export async function setSendAsAliases(accountId: string, emails: readonly string[]): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM send_as_aliases WHERE account_id = $1", [accountId]);
  for (const email of new Set(emails.map(normalizeEmail).filter(Boolean))) {
    await db.execute("INSERT OR IGNORE INTO send_as_aliases (id, account_id, email) VALUES ($1, $2, $3)", [`${accountId}:${email}`, accountId, email]);
  }
}
