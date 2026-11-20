/**
 * The hint under an icon: what it does and its key, shown on hover or keyboard focus after a short beat (the
 * system's title waits about a second). CSS only: the control it sits in is `group/tip relative`.
 */
export function Tip({ label, keys }: { label: string; keys?: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-control bg-tip px-2 py-1 text-meta font-medium whitespace-nowrap text-tip-ink opacity-0 shadow-float transition-opacity duration-(--vm-fast) group-hover/tip:opacity-100 group-hover/tip:delay-200 group-focus-visible/tip:opacity-100"
    >
      {label}
      {keys && <kbd className="rounded-[3px] bg-tip-ink/15 px-1 font-sans text-tip-ink/75">{keys}</kbd>}
    </span>
  );
}
