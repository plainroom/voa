import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getUnreadInboxCount } from "./db/threads";

let lastCount = -1;

/** Clears the cached count so the next update always reaches the Dock and tray. */
export function resetBadgeCache(): void {
  lastCount = -1;
}

/**
 * Puts the unread inbox count on the Dock badge and the tray tooltip (all accounts).
 * Zero clears the badge. Safe to call outside Tauri: the Dock and tray calls are best-effort.
 */
export async function updateBadgeCount(): Promise<void> {
  try {
    const count = await getUnreadInboxCount();
    if (count === lastCount) return;
    lastCount = count;

    try {
      await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
    } catch {
      // badge count may not be supported on all platforms
    }

    const tooltip = count > 0 ? `voa - ${count} unread` : "voa";
    try {
      await invoke("set_tray_tooltip", { tooltip });
    } catch {
      // tray tooltip update is best-effort
    }

    // Number next to the menu-bar icon (macOS). Cleared when the inbox is empty.
    try {
      await invoke("set_tray_title", { title: count > 0 ? String(count) : "" });
    } catch {
      // tray title is best-effort
    }
  } catch (err) {
    console.error("Failed to update badge count:", err);
  }
}
