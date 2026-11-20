import { create } from "zustand";

/** The delayed send of a reply: its timer, and whether the "Sending..." toast with Undo shows. */
interface UndoSendState {
  undoSendTimer: ReturnType<typeof setTimeout> | null;
  undoSendVisible: boolean;
  setUndoSendTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  setUndoSendVisible: (visible: boolean) => void;
}

export const useComposerStore = create<UndoSendState>((set) => ({
  undoSendTimer: null,
  undoSendVisible: false,
  setUndoSendTimer: (undoSendTimer) => set({ undoSendTimer }),
  setUndoSendVisible: (undoSendVisible) => set({ undoSendVisible }),
}));
