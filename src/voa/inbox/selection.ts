import type { ThreadKey } from "@/services/db/threads";
import { sameKey } from "@/stores/list";

/** Cmd+click: the row joins the selection, or leaves it. */
export function togglePicked(picked: readonly ThreadKey[], key: ThreadKey): ThreadKey[] {
  return picked.some((k) => sameKey(k, key)) ? picked.filter((k) => !sameKey(k, key)) : [...picked, key];
}

/** Shift+click: every row from the anchor through the one clicked, in list order. */
export function rangePicked(rows: readonly ThreadKey[], from: number, to: number): ThreadKey[] {
  if (rows.length === 0) return [];
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(rows.length - 1, Math.max(from, to));
  return rows.slice(start, end + 1);
}

/** The picked rows still on screen: a sync may have taken one away since it was picked. */
export function stillShown(picked: readonly ThreadKey[], rows: readonly ThreadKey[]): ThreadKey[] {
  return picked.filter((k) => rows.some((row) => sameKey(row, k)));
}
