import type { ReactNode } from "react";

/** A quiet centered message for a list with nothing in it, with an optional action below. */
export function Empty({ title, line, children }: { title: string; line?: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 pb-24 text-center">
      <div className="text-title font-semibold text-ink">{title}</div>
      {line && <div className="text-body text-ink-3">{line}</div>}
      {children && <div className="pt-3">{children}</div>}
    </div>
  );
}
