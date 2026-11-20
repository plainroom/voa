import type { SelectHTMLAttributes } from "react";

/** A native choice among a few options: no box, a hairline underneath, the accent when focused. */
export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className="h-8 w-full cursor-default border-0 border-b border-line bg-transparent px-0 text-body text-ink outline-none transition-colors duration-(--vm-fast) focus:border-accent"
    >
      {children}
    </select>
  );
}
