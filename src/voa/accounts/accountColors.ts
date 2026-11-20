/** Token names; the CSS custom properties for them are defined with the theme. */
export const ACCOUNT_COLORS: readonly string[] = [
  "account-1",
  "account-2",
  "account-3",
  "account-4",
  "account-5",
  "account-6",
];

/** First color not in `used`; wraps around to the first when all are taken. */
export function nextAccountColor(used: string[]): string {
  return ACCOUNT_COLORS.find((c) => !used.includes(c)) ?? ACCOUNT_COLORS[0]!;
}
