import type { InputHTMLAttributes, ReactNode } from "react";

/** A native checkbox in the accent, with its label beside it; the whole row toggles it. */
export function Checkbox({ children, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { children: ReactNode }) {
  return (
    <label className="flex min-h-8 cursor-default items-center gap-2 text-body text-ink">
      <input {...rest} type="checkbox" className="size-3.5 shrink-0 accent-accent" />
      {children}
    </label>
  );
}
