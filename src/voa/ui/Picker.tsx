import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TextField } from "./TextField";

export interface PickerItem {
  id: string;
  label: string;
  /** Drawn before the label (a LabelTag). */
  lead?: ReactNode;
  hint?: string;
}

export type PickerChoice = { id: string } | { at: Date };

export interface PickerProps {
  items: PickerItem[];
  /** A field above the items; what it parses to is picked with Enter. */
  freeText?: { placeholder: string; parse: (s: string) => Date | null };
  onPick: (choice: PickerChoice) => void;
  onClose?: () => void;
}

const formatAt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A small floating list: arrows move, Enter picks, Esc closes. */
export function Picker({ items, freeText, onPick, onClose }: PickerProps) {
  const [active, setActive] = useState(0);
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const parsed = freeText && text.trim() ? freeText.parse(text.trim()) : null;

  useEffect(() => {
    if (!freeText) rootRef.current?.focus();
  }, [freeText]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (text.trim()) {
        if (parsed) onPick({ at: parsed });
      } else {
        const item = items[active];
        if (item) onPick({ id: item.id });
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="listbox"
      className="w-80 animate-fade-in rounded-panel bg-surface p-1.5 text-body shadow-float outline-none"
    >
      {freeText && (
        <div className="px-2.5 pt-1 pb-2">
          <TextField autoFocus placeholder={freeText.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
          {text.trim() && <div className="pt-1.5 text-meta text-ink-3">{parsed ? formatAt(parsed) : "Not a time I understand"}</div>}
        </div>
      )}
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === active && !text.trim()}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick({ id: item.id })}
          className={`flex h-8 w-full items-center justify-between rounded-control px-2.5 text-left text-ink ${
            i === active && !text.trim() ? "bg-selected" : ""
          }`}
        >
          <span className="flex items-center">
            {item.lead}
            {item.label}
          </span>
          {item.hint && <span className="text-meta text-ink-3">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** Where a Picker floats: over the screen, near the top; a click outside closes it. A dialog, so the list's keys wait. */
export function PickerLayer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
    >
      {children}
    </div>
  );
}
