/** The account's color: 6px, muted. `color` is a token name ("account-1".."account-6"). */
export function AccountDot({ color }: { color: string | null | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: `var(--color-${color ?? "account-1"})` }}
    />
  );
}
