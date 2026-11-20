/** A time group's label above its rows: Today, Yesterday, This week, a month. */
export function GroupHeader({ label }: { label: string }) {
  return (
    <div role="heading" aria-level={2} className="px-8 pt-6 pb-1.5 text-meta font-medium text-ink-3 select-none">
      {label}
    </div>
  );
}
