import { forwardRef, type InputHTMLAttributes } from "react";

/** A single-line field: no box, a hairline underneath, the accent when focused. */
export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="text"
      spellCheck={false}
      autoComplete="off"
      {...rest}
      className={`h-8 w-full border-0 border-b border-line bg-transparent px-0 text-body text-ink outline-none transition-colors duration-(--vm-fast) placeholder:text-ink-3 focus:border-accent`}
    />
  );
});
