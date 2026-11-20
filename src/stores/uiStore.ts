import { create } from "zustand";

/** Whether the machine is online: offline, actions wait in the queue instead of reaching the provider. */
interface UIState {
  isOnline: boolean;
  setOnline: (online: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isOnline: true,
  setOnline: (isOnline) => set({ isOnline }),
}));
