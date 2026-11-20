/** A label before a subject: its name in lower case, in its hue mixed into the grey text, over a faint tint of it. Not a button. */
export function LabelTag({ name }: { name: string }) {
  const hue = `var(--color-label-${name}, var(--color-ink-3))`;
  return (
    <span
      className="mr-2 inline-flex h-4 shrink-0 items-center rounded-[3px] px-1 align-[1px] text-[10.5px] leading-none font-medium"
      style={{ color: `color-mix(in srgb, ${hue} 70%, var(--color-ink-2))`, background: `color-mix(in srgb, ${hue} 13%, transparent)` }}
    >
      {name}
    </span>
  );
}
