import type { ReactNode } from "react";

/** A label in the left column and its control beside it; the label matches the recipient field's. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-ink-3">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
