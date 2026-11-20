import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Tip } from "./Tip";
import { Paperclip } from "lucide-react";
import { AccountDot } from "./AccountDot";
import { LabelTag } from "./LabelTag";
import { useToastStore } from "./Toast";

export interface RowProps {
  dotColor: string | null;
  from: string;
  subject: string;
  preview: string;
  date: string;
  selected: boolean;
  unread: boolean;
  /** A small paperclip before the date: the conversation has files. */
  attachment?: boolean;
  /** The conversation's labels (Settings > Labels), shown before the subject. */
  labels?: string[];
  /** A login code found in this conversation. A button copies it and does not open the row. */
  code?: string | null;
  onOpen: () => void;
  /** Cmd+click or Shift+click. A plain click still opens. */
  onPick?: (event: MouseEvent) => void;
  /** Rendered only while the row is hovered or selected; outside that the row is clean. */
  actions?: ReactNode;
}

/**
 * Ellipsis only when the words are wider than the column. One pixel of slack avoids a subpixel
 * false positive, which otherwise paints "..." at the far edge of a line that still fits.
 */
export function lineOverflows(scrollWidth: number, clientWidth: number): boolean {
  return clientWidth > 0 && scrollWidth > clientWidth + 1;
}

/** One conversation, one line: account dot, sender, subject, grey preview, date. */
export function Row({
  dotColor,
  from,
  subject,
  preview,
  date,
  selected,
  unread,
  attachment = false,
  labels = [],
  code = null,
  onOpen,
  onPick,
  actions,
}: RowProps) {
  const [hovered, setHovered] = useState(false);
  const showActions = actions != null && (hovered || selected);
  const columnRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const column = columnRef.current;
    const line = lineRef.current;
    if (!column || !line) return;
    const measure = () => setOverflows(lineOverflows(line.scrollWidth, line.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [subject, preview, showActions, labels.length]);

  return (
    <div
      role="row"
      aria-selected={selected}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e: MouseEvent) => {
        // The list behind this row clears a selection on click. The row owns its click.
        e.stopPropagation();
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          onPick?.(e);
          return;
        }
        onOpen();
      }}
      className={`relative flex cursor-default gap-3 px-8 text-body select-none ${
        code ? "items-start py-1.5" : "h-9 items-center"
      } ${selected ? "bg-selected" : "hover:bg-hover"}`}
    >
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <span className={`inline-flex shrink-0 ${code ? "mt-1.5" : ""}`}>
        <AccountDot color={dotColor} />
      </span>
      <span className={`w-48 shrink-0 truncate ${unread ? "font-semibold text-ink" : "text-ink-2"}`}>{from}</span>
      {/* The line shrinks to its words and only ellipsizes once it hits the column. Buttons stay on the right. */}
      <span ref={columnRef} className="flex min-w-0 flex-1 flex-col items-start">
        <span ref={lineRef} className={`block w-full min-w-0 overflow-hidden whitespace-nowrap ${overflows ? "text-ellipsis" : ""}`}>
          {labels.map((l) => (
            <LabelTag key={l} name={l} />
          ))}
          <span className={unread ? "font-medium text-ink" : "text-ink-2"}>{subject}</span>
          {preview && <span className="ml-3 text-ink-3">{preview}</span>}
        </span>
        {code && (
          <button
            type="button"
            aria-label={`Copy code ${code}`}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              void navigator.clipboard.writeText(code).then(
                () => useToastStore.getState().show("Copied"),
                () => useToastStore.getState().show("Couldn't copy"),
              );
            }}
            className="mt-1 inline-flex rounded-control border border-line px-2 py-0.5 text-meta text-ink-2 transition-colors duration-(--vm-fast) hover:bg-hover hover:text-ink"
          >
            Copy code: {code}
          </button>
        )}
      </span>
      {showActions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
      {attachment && <Paperclip aria-label="Has attachments" size={12} strokeWidth={1.75} className="shrink-0 text-ink-3" />}
      <span className="w-14 shrink-0 text-right text-meta text-ink-3 tabular-nums">{date}</span>
    </div>
  );
}

/** An icon action inside a row (Done, Star, Remind me). Clicking it never opens the row. */
export function RowAction({ label, keys, onClick, children }: { label: string; keys?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={keys}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      className="group/tip relative inline-flex size-6 items-center justify-center rounded-control text-ink-3 transition-colors duration-(--vm-fast) hover:bg-canvas hover:text-ink"
    >
      {children}
      <Tip label={label} keys={keys} />
    </button>
  );
}
