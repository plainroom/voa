import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tip } from "./Tip";

type Variant = "primary" | "quiet";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-canvas hover:opacity-90",
  quiet: "text-ink-2 hover:bg-hover hover:text-ink",
};

/** Text button. `primary` is the one strong action on a screen; `quiet` everything else. */
export function Button({
  variant = "quiet",
  children,
  ...rest
}: { variant?: Variant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-7 items-center gap-1.5 rounded-control px-3 text-body font-medium transition-colors duration-(--vm-fast) focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 ${VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}

/** Icon-only button: a quiet glyph, grey until hovered, with its Tip (what it does, and its key). */
export function IconButton({
  label,
  keys,
  children,
  ...rest
}: { label: string; keys?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={keys}
      {...rest}
      className="group/tip relative inline-flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors duration-(--vm-fast) hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
      <Tip label={label} keys={keys} />
    </button>
  );
}

/** The one Save of a form, always called Save: off until its field differs from what was saved, and while it writes. */
export function SaveButton({ changed, onSave }: { changed: boolean; onSave: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const click = () => {
    setBusy(true);
    void onSave().finally(() => setBusy(false));
  };
  return (
    <Button variant="primary" disabled={!changed || busy} onClick={click}>
      Save
    </Button>
  );
}
