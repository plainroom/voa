import { searchMessages, type SearchResult } from "@/services/db/search";

/** One conversation that matched, at the time of its newest matching message. */
export interface SearchHit {
  accountId: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  /** Milliseconds. */
  date: number;
}

const LIMIT = 200;

/** FTS5 rejects some free text (a lone quote, a dash); the same words as a phrase always parse. */
async function run(query: string): Promise<SearchResult[]> {
  try {
    return await searchMessages(query, undefined, LIMIT);
  } catch {
    try {
      return await searchMessages(`"${query.replace(/"/g, '""')}"`, undefined, LIMIT);
    } catch {
      return [];
    }
  }
}

/** Every account at once (no account filter), one hit per conversation, newest first. */
export async function searchThreads(query: string): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const hits = new Map<string, SearchHit>();
  for (const m of await run(query)) {
    const id = `${m.account_id}:${m.thread_id}`;
    const seen = hits.get(id);
    if (seen && seen.date >= m.date) continue;
    hits.set(id, {
      accountId: m.account_id,
      threadId: m.thread_id,
      from: m.from_name || m.from_address || "Unknown sender",
      subject: m.subject || "(no subject)",
      snippet: m.snippet ?? "",
      date: m.date,
    });
  }
  return [...hits.values()].sort((a, b) => b.date - a.date);
}
