import { useEffect, useState, useCallback, useRef } from "react";
import { Outlet } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AddAccount } from "./voa/accounts/AddAccount";
import { useUIStore } from "./stores/uiStore";
import { APPEARANCE, applyAppearance, readAppearance } from "./voa/settings/appearance";
import { readAhead } from "./voa/ai/apple";
import { flight } from "./voa/ai/tasks/flight";
import { labelAhead } from "./voa/ai/tasks/labels";
import { useAccountStore } from "./stores/accountStore";
import { runMigrations } from "./services/db/migrations";
import { getAllAccounts, fillMissingAccountColors } from "./services/db/accounts";
import { getSetting } from "./services/db/settings";
import { startBackgroundSync, stopBackgroundSync, syncAccount, setSyncWindowVisible, triggerSync, onSyncStatus } from "./services/gmail/syncManager";
import { initializeClients } from "./services/gmail/tokenManager";
import { recoverOrphanSnoozes, startSnoozeChecker, stopSnoozeChecker } from "./services/snooze/snoozeManager";
import { startQueueProcessor, stopQueueProcessor, triggerQueueFlush } from "./services/queue/queueProcessor";
import { initNotifications, notifyNewInbox } from "./services/notifications/notificationManager";
import { initDeepLinkHandler } from "./services/deepLinkHandler";
import { updateBadgeCount } from "./services/badgeManager";
import { UndoSendToast } from "./voa/compose/UndoSendToast";
import { surfaceUnsentReplies } from "./voa/thread/replySend";
import { ToastHost } from "./voa/ui";
import { useSearchHotkey } from "./voa/search/useSearchHotkey";

/** The browser (the /ds page, the ?demo=1 inbox) has no Tauri: nothing to start there. */
const inTauri = "__TAURI_INTERNALS__" in window;

async function loadAccounts() {
  const dbAccounts = await getAllAccounts();
  return dbAccounts.map((a) => ({
    id: a.id,
    email: a.email,
    displayName: a.display_name,
    avatarUrl: a.avatar_url,
    isActive: a.is_active === 1,
    provider: a.provider,
  }));
}

/** The cards' tasks read the inbox ahead (a booking shows at once when opened), then the inbox is labeled. */
function aiAhead(): void {
  void readAhead([flight])
    .then(labelAhead)
    .catch((err: unknown) => console.warn("ai read-ahead failed", err));
}

export default function App() {
  useSearchHotkey();
  const [initialized, setInitialized] = useState(!inTauri);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const deepLinkCleanupRef = useRef<(() => void) | undefined>(undefined);

  // Network status: flush the offline queue and sync when back online.
  useEffect(() => {
    if (!inTauri) return;
    const { setOnline } = useUIStore.getState();
    setOnline(navigator.onLine);
    const handleOnline = () => {
      setOnline(true);
      triggerQueueFlush();
      const activeIds = useAccountStore
        .getState()
        .accounts.filter((a) => a.isActive)
        .map((a) => a.id);
      if (activeIds.length > 0) triggerSync(activeIds);
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const open = () => setShowAddAccount(true);
    window.addEventListener("voa-add-account", open);
    return () => window.removeEventListener("voa-add-account", open);
  }, []);

  // Startup: database, accounts, sync, snooze and queue checkers, notifications, deep links.
  useEffect(() => {
    if (!inTauri) return;
    async function init() {
      try {
        await runMigrations();
        applyAppearance(readAppearance(await getSetting(APPEARANCE)));
        // Threads under the voa snooze label with no time here (a lost database) come back now.
        recoverOrphanSnoozes().catch((err) => console.error("Remind me: recovery failed:", err));

        await fillMissingAccountColors();
        const mapped = await loadAccounts();
        const savedAccountId = await getSetting("active_account_id");
        useAccountStore.getState().setAccounts(mapped, savedAccountId);

        await initializeClients();
        // What is already in the inbox is read once at startup; new mail after each sync (voa-sync-done).
        aiAhead();

        const activeIds = mapped.filter((a) => a.isActive).map((a) => a.id);

        if (activeIds.length > 0) startBackgroundSync(activeIds);
        startSnoozeChecker();
        startQueueProcessor();

        await initNotifications();
        deepLinkCleanupRef.current = await initDeepLinkHandler();
        // A reply the app quit on during its Undo window is shown (never sent: it may already have gone).
        void surfaceUnsentReplies(mapped.map((a) => a.id));
        await updateBadgeCount();
      } catch (err) {
        console.error("Failed to initialize:", err);
      }
      setInitialized(true);
      // Created hidden. Shown once startup finishes, so the first thing on screen is the inbox.
      // An autostart launch (--hidden) stays in the Dock until the user opens it.
      const hidden = await invoke<boolean>("started_hidden").catch(() => false);
      if (!hidden) {
        const main = getCurrentWindow();
        await main.show().catch(() => {});
        await main.setFocus().catch(() => {});
      }
    }

    init();

    return () => {
      stopBackgroundSync();
      stopSnoozeChecker();
      stopQueueProcessor();
      deepLinkCleanupRef.current?.();
    };
  }, []);

  // A finished sync that found mail refreshes the lists and the Dock badge, and notifies what is new. An idle check stays quiet.
  // So does a part of a first sync that landed (phase "done") while the account is still syncing.
  useEffect(() => {
    if (!inTauri) return;
    return onSyncStatus((_accountId, status, progress) => {
      if (status === "done" || status === "error" || progress?.phase === "done") {
        window.dispatchEvent(new Event("voa-sync-done"));
        void updateBadgeCount();
        void notifyNewInbox().catch((err) => console.error("voa could not check for new mail to notify:", err));
      }
    });
  }, []);

  // On screen, ask every few seconds. Hidden, once a minute. Coming back asks at once.
  useEffect(() => {
    if (!inTauri) return;
    const apply = () => setSyncWindowVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);

  // Every sync and local inbox change (Remind me returns) fire voa-sync-done.
  useEffect(() => {
    if (!inTauri) return;
    const onLocal = () => {
      void updateBadgeCount();
      aiAhead();
    };
    window.addEventListener("voa-sync-done", onLocal);
    return () => window.removeEventListener("voa-sync-done", onLocal);
  }, []);

  const handleAddAccountSuccess = useCallback(async () => {
    setShowAddAccount(false);
    const mapped = await loadAccounts();
    useAccountStore.getState().setAccounts(mapped);
    await initializeClients();

    const newest = mapped[mapped.length - 1];
    if (newest) {
      // Sync the new account before restarting the timer so it does not queue behind the others.
      syncAccount(newest.id);
    }
    startBackgroundSync(
      mapped.filter((a) => a.isActive).map((a) => a.id),
      true,
    );
    window.dispatchEvent(new Event("voa-sync-done"));
  }, []);

  if (!initialized) return <div className="h-screen bg-canvas" />;

  return (
    <div className="h-screen overflow-hidden bg-canvas text-ink">
      <Outlet />
      <ToastHost />
      <UndoSendToast />
      {showAddAccount && <AddAccount onClose={() => setShowAddAccount(false)} onSuccess={handleAddAccountSuccess} />}
    </div>
  );
}
