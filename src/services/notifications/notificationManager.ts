import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  registerActionTypes,
  onAction,
} from "@tauri-apps/plugin-notification";
import { getSetting } from "../db/settings";
import { getUnreadInboxSince } from "../db/threads";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

let initialized = false;
let notificationsEnabled = true;

interface NotificationContext {
  threadId?: string;
  accountId?: string;
  fromAddress?: string;
  subject?: string;
}

let lastNotificationContext: NotificationContext | null = null;
const recentContexts = new Map<string, NotificationContext>();

async function showAndFocusMainWindow(): Promise<void> {
  const mainWindow = await WebviewWindow.getByLabel("main");
  if (mainWindow) {
    await mainWindow.show();
    await mainWindow.setFocus();
  }
}

/**
 * Initialize notification permissions and action types.
 */
export async function initNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const setting = await getSetting("notifications_enabled");
  notificationsEnabled = setting !== "false";

  if (!notificationsEnabled) return;

  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }

  if (!granted) {
    notificationsEnabled = false;
    return;
  }

  // Register action types and handlers (not available on all platforms)
  try {
    await registerActionTypes([
      {
        id: "default",
        actions: [],
      },
      {
        id: "email",
        actions: [
          { id: "archive", title: "Archive" },
        ],
      },
    ]);

    await onAction(async (event) => {
      const actionId = event.actionTypeId;
      const ctx = lastNotificationContext;

      if (actionId === "archive" && ctx?.threadId && ctx?.accountId) {
        try {
          const { archiveThread } = await import("../emailActions");
          await archiveThread(ctx.accountId, ctx.threadId, []);
        } catch (err) {
          console.error("Failed to archive from notification:", err);
        }
      } else {
        await showAndFocusMainWindow();
        if (ctx?.threadId && ctx.accountId) {
          // Loaded here: the router reaches the app, which reaches this module.
          const { router } = await import("../../router");
          void router.navigate({ to: "/t/$accountId/$threadId", params: { accountId: ctx.accountId, threadId: ctx.threadId } });
        }
      }
    });
  } catch {
    // registerActionTypes/onAction not available on this platform (e.g. Windows)
  }
}

/**
 * Show a notification for new emails.
 * Batches notifications to avoid spam during sync.
 */
let pendingCount = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function queueNewEmailNotification(
  from: string,
  subject: string,
  threadId?: string,
  accountId?: string,
  fromAddress?: string,
): void {
  if (!notificationsEnabled) return;

  pendingCount++;

  // Store context for action handling
  const ctx = { threadId, accountId, fromAddress, subject };
  lastNotificationContext = ctx;
  if (threadId) recentContexts.set(threadId, ctx);

  // Debounce: wait 2s before showing, to batch during sync
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    if (pendingCount === 1) {
      sendNotification({
        title: from,
        body: subject || "(No subject)",
        actionTypeId: "email",
      });
    } else if (pendingCount > 1) {
      // Archive would act on one of them only (the last): a batch has no action, a click opens voa.
      sendNotification({
        title: "voa",
        body: `${pendingCount} new emails`,
        actionTypeId: "default",
      });
    }
    pendingCount = 0;
    notifyTimer = null;
  }, 2000);
}


// Mail older than the app's start is not news: what was unread at launch, or what an account's first sync brings, stays quiet.
const startedAt = Date.now();
/** Each conversation's newest message notified once (account, thread, time): a later reply in it is news again. */
const notified = new Set<string>();

/**
 * Notifies the new unread mail of the inbox list, from any provider. Called after every sync: the one place that decides
 * what is new, so Gmail, Outlook and IMAP notify alike.
 */
export async function notifyNewInbox(): Promise<void> {
  for (const t of await getUnreadInboxSince(startedAt)) {
    const key = `${t.account_id}:${t.id}:${t.last_message_at}`;
    if (notified.has(key)) continue;
    notified.add(key);
    queueNewEmailNotification(t.from_name ?? t.from_address ?? "Unknown", t.subject ?? "", t.id, t.account_id, t.from_address ?? undefined);
  }
}
