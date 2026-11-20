export type ZeroState = "allClear" | "accountClear";

/**
 * What an empty inbox means. `counts` is the inbox count per account (a missing account is 0),
 * `filter` the account the list is narrowed to. Null when the list still has mail.
 * A sync in progress or a failed sync never replaces this: that stays a quiet note on the top bar.
 */
export function zeroState({
  counts,
  filter,
}: {
  counts: Record<string, number>;
  filter: string | null;
}): ZeroState | null {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (filter) {
    if ((counts[filter] ?? 0) > 0) return null;
    if (total > 0) return "accountClear";
  } else if (total > 0) {
    return null;
  }
  return "allClear";
}
