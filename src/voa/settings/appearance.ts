import { useEffect, useState } from "react";
import { create } from "zustand";

/** System follows the Mac; Light and Dark hold whatever the Mac does. Settings > Appearance. */
export type Appearance = "system" | "light" | "dark";

/** The settings row it is kept in. */
export const APPEARANCE = "appearance";

export const readAppearance = (v: string | null): Appearance => (v === "light" || v === "dark" ? v : "system");

const useAppearanceStore = create<{ appearance: Appearance }>(() => ({ appearance: "system" }));

/**
 * The app in that scheme: the tokens follow `color-scheme` (light-dark()), which the root's
 * `scheme-light` / `scheme-dark` class sets, and the window's own chrome (title bar, traffic lights).
 */
export function applyAppearance(a: Appearance): void {
  useAppearanceStore.setState({ appearance: a });
  const root = document.documentElement.classList;
  root.toggle("scheme-light", a === "light");
  root.toggle("scheme-dark", a === "dark");
  if ("__TAURI_INTERNALS__" in window)
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(a === "system" ? null : a))
      .catch((err: unknown) => console.warn("set window theme failed", err));
}

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Whether the app shows dark now: the choice, or the Mac's own mode under System (and when it changes). */
export function useDark(): boolean {
  const appearance = useAppearanceStore((s) => s.appearance);
  const [macDark, setMacDark] = useState(() => media().matches);
  useEffect(() => {
    const m = media();
    const on = () => setMacDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return appearance === "system" ? macDark : appearance === "dark";
}

export const useAppearance = () => useAppearanceStore((s) => s.appearance);
