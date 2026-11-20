import { describe, it, expect } from "vitest";
import { useComposerStore } from "./composerStore";

describe("composerStore (undo send)", () => {
  it("starts with no pending send", () => {
    const state = useComposerStore.getState();
    expect(state.undoSendTimer).toBeNull();
    expect(state.undoSendVisible).toBe(false);
  });

  it("tracks the pending send's timer and toast", () => {
    const timer = setTimeout(() => {}, 1000);
    useComposerStore.getState().setUndoSendTimer(timer);
    useComposerStore.getState().setUndoSendVisible(true);
    expect(useComposerStore.getState().undoSendTimer).toBe(timer);
    expect(useComposerStore.getState().undoSendVisible).toBe(true);
    clearTimeout(timer);
    useComposerStore.getState().setUndoSendTimer(null);
    useComposerStore.getState().setUndoSendVisible(false);
  });
});
