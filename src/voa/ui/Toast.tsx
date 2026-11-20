import { create } from "zustand";

const TOAST_MS = 5_000;

type Undo = () => Promise<void>;

/** A button on a notice that is not Undo (e.g. Open a draft). */
export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastState {
  current: { id: number; message: string; undoable: boolean; action?: ToastAction } | null;
  /** The last action's undo: kept after the toast fades (Cmd+Z still works) until used or replaced. */
  lastUndo: Undo | null;
  /** Without `undo` it is a notice: no Undo, and Cmd+Z keeps undoing the last action. */
  show: (message: string, undo?: Undo) => void;
  /** A notice with its own button; Cmd+Z keeps undoing the last action. */
  showAction: (message: string, label: string, run: () => void) => void;
  undoLast: () => Promise<void>;
}

let nextId = 0;

/**
 * Starts the 5 s once the window is seen: a toast shown while it is hidden (an autostart launch, closed to the Dock)
 * waits there instead of fading unseen.
 */
function whenSeen(fade: () => void): void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") {
    setTimeout(fade, TOAST_MS);
    return;
  }
  const onChange = () => {
    if (document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", onChange);
    setTimeout(fade, TOAST_MS);
  };
  document.addEventListener("visibilitychange", onChange);
}

export const useToastStore = create<ToastState>((set, get) => ({
  current: null,
  lastUndo: null,
  show: (message, undo) => {
    const id = ++nextId;
    set(undo ? { current: { id, message, undoable: true }, lastUndo: undo } : { current: { id, message, undoable: false } });
    whenSeen(() => {
      if (get().current?.id === id) set({ current: null });
    });
  },
  showAction: (message, label, run) => {
    const id = ++nextId;
    set({ current: { id, message, undoable: false, action: { label, run } } });
    whenSeen(() => {
      if (get().current?.id === id) set({ current: null });
    });
  },
  undoLast: async () => {
    const undo = get().lastUndo;
    set({ current: null, lastUndo: null });
    if (undo) await undo();
  },
}));

/** One toast at a time, 5 s once the window is seen, bottom-left. `undo` also runs on Z (`undoLast`). */
export function useToast(): { show: (message: string, undo?: Undo) => void } {
  const show = useToastStore((s) => s.show);
  return { show };
}

/** The toast itself: a message and, unless it is a notice, Undo (or the notice's own action). */
export function Toast({ message, onUndo, action }: { message: string; onUndo?: () => void; action?: ToastAction }) {
  return (
    <div
      role="status"
      className="flex animate-toast-in items-center gap-4 rounded-panel bg-surface py-2.5 pr-3 pl-4 text-body text-ink shadow-float"
    >
      <span>{message}</span>
      {onUndo && (
        <>
          <button
            type="button"
            onClick={onUndo}
            className="rounded-control px-1.5 py-0.5 font-medium text-accent transition-opacity duration-(--vm-fast) hover:opacity-70"
          >
            Undo
          </button>
          <kbd className="font-sans text-meta text-ink-3">⌘Z</kbd>
        </>
      )}
      {action && (
        <button
          type="button"
          onClick={action.run}
          className="rounded-control px-1.5 py-0.5 font-medium text-accent transition-opacity duration-(--vm-fast) hover:opacity-70"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Renders the current toast, bottom-left. Mount once at the root. */
export function ToastHost() {
  const current = useToastStore((s) => s.current);
  const undoLast = useToastStore((s) => s.undoLast);
  if (!current) return null;
  const action = current.action;
  return (
    <div className="pointer-events-auto fixed bottom-6 left-6 z-50" key={current.id}>
      <Toast
        message={current.message}
        onUndo={current.undoable ? () => void undoLast() : undefined}
        action={
          action && {
            label: action.label,
            run: () => {
              useToastStore.setState({ current: null });
              action.run();
            },
          }
        }
      />
    </div>
  );
}
