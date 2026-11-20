import { useEffect, useRef } from "react";
import type { ThreadKey } from "@/services/db/threads";
import { sameKey, type InboxList } from "@/stores/list";

export interface InboxKeyHandlers {
  /** Rows in display order. */
  rows: ThreadKey[];
  selected: ThreadKey | null;
  /** Account ids in tab order: 1 is the first, 0 is all. */
  accountIds: string[];
  select: (k: ThreadKey) => void;
  /** Cmd+A. The screen decides which list it applies to. */
  selectAll: () => void;
  /** Escape clears a multi-selection first. True when it did, so the list stays put. */
  clearSelection: () => boolean;
  /** Backspace or Delete. The screen decides which list it applies to. */
  remove: () => void;
  open: (k: ThreadKey) => void;
  done: (k: ThreadKey) => void;
  star: (k: ThreadKey) => void;
  /** Opens Remind me for the row. */
  remind: (k: ThreadKey) => void;
  undo: () => void;
  compose: () => void;
  search: () => void;
  settings: () => void;
  setFilter: (accountId: string | null) => void;
  goList: (list: InboxList) => void;
}

const G_TIMEOUT_MS = 2_000;
const G_LISTS: Record<string, InboxList> = { i: "INBOX", s: "STARRED", h: "SNOOZED", p: "SPAM", t: "TRASH" };

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

/** Any dialog is open: its keys are its own. */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}

/** Enter on a focused button or link is that control's click, not "open the thread". */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a") !== null;
}

/** The inbox's keyboard: j/k, Enter/o, e, s, h, z, c, /, Esc, comma, 1-9 and 0, g then i/s/h/p, Cmd+A, Cmd+Z, Backspace. */
export function useInboxKeys(handlers: InboxKeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let gAt = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target) || overlayOpen()) return;
      const h = ref.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        h.selectAll();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        h.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;

      if (gAt && Date.now() - gAt < G_TIMEOUT_MS) {
        gAt = 0;
        const list = G_LISTS[key];
        if (list) {
          e.preventDefault();
          h.goList(list);
        }
        return;
      }
      gAt = 0;

      const index = h.rows.findIndex((k) => sameKey(k, h.selected));
      const current = index === -1 ? null : h.rows[index]!;

      switch (key) {
        case "Escape":
          if (h.clearSelection()) break;
          h.goList("INBOX");
          break;
        case "g":
          e.preventDefault();
          gAt = Date.now();
          return;
        case "j":
        case "ArrowDown": {
          const target = index === -1 ? h.rows[0] : h.rows[Math.min(index + 1, h.rows.length - 1)];
          if (target) h.select(target);
          break;
        }
        case "k":
        case "ArrowUp": {
          const target = index === -1 ? h.rows[0] : h.rows[Math.max(index - 1, 0)];
          if (target) h.select(target);
          break;
        }
        case "Enter":
          if (onControl(e.target)) return;
          if (current) h.open(current);
          break;
        case "o":
          if (current) h.open(current);
          break;
        case "e":
          if (current) h.done(current);
          break;
        case "s":
          if (current) h.star(current);
          break;
        case "h":
          if (current) h.remind(current);
          break;
        case "Backspace":
        case "Delete":
          h.remove();
          break;
        case "c":
          h.compose();
          break;
        case "/":
          h.search();
          break;
        case ",":
          h.settings();
          break;
        case "0":
          h.setFilter(null);
          break;
        default: {
          const n = Number(key);
          if (Number.isInteger(n) && n >= 1 && n <= 9) {
            const id = h.accountIds[n - 1];
            if (id) h.setFilter(id);
            break;
          }
          return;
        }
      }
      e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
