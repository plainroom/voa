import { forwardRef, type TextareaHTMLAttributes } from "react";

/** A multi-line field: a hairline box (a few lines need edges, unlike TextField), the accent when focused. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={4}
      {...rest}
      className="block w-full resize-y rounded-control border border-line bg-transparent px-3 py-2 text-body text-ink outline-none transition-colors duration-(--vm-fast) placeholder:text-ink-3 focus:border-accent"
    />
  );
});
