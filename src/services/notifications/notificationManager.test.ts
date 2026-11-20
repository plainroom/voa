const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: (...a: unknown[]) => sendNotification(...a),
  registerActionTypes: vi.fn(),
  onAction: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: vi.fn() } }));
vi.mock("../db/settings", () => ({ getSetting: vi.fn() }));
const getUnreadInboxSince = vi.fn();
vi.mock("../db/threads", () => ({ getUnreadInboxSince: (...a: unknown[]) => getUnreadInboxSince(...a) }));

import { notifyNewInbox, queueNewEmailNotification } from "./notificationManager";

beforeEach(() => {
  vi.useFakeTimers();
  sendNotification.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("new mail notifications", () => {
  it("one new email offers Archive", () => {
    queueNewEmailNotification("Ana", "Lunch", "t1", "a");
    vi.advanceTimersByTime(2000);
    expect(sendNotification).toHaveBeenCalledWith({ title: "Ana", body: "Lunch", actionTypeId: "email" });
  });

  it("a batch offers no Archive (it would archive only the last one)", () => {
    queueNewEmailNotification("Ana", "Lunch", "t1", "a");
    queueNewEmailNotification("Bob", "Report", "t2", "a");
    vi.advanceTimersByTime(2000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({ title: "voa", body: "2 new emails", actionTypeId: "default" });
  });
});

describe("notifyNewInbox", () => {
  const row = (id: string, at: number) => ({ account_id: "a", id, subject: `S ${id}`, last_message_at: at, from_name: "Ana", from_address: "ana@x.com" });

  it("notifies new unread inbox mail of any provider once, and a later reply in it again", async () => {
    getUnreadInboxSince.mockResolvedValue([row("t1", Date.now() + 1)]);
    await notifyNewInbox();
    await notifyNewInbox();
    vi.advanceTimersByTime(2000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({ title: "Ana", body: "S t1", actionTypeId: "email" });
    expect(getUnreadInboxSince.mock.calls[0]![0]).toBeLessThanOrEqual(Date.now());

    getUnreadInboxSince.mockResolvedValue([row("t1", Date.now() + 2)]);
    await notifyNewInbox();
    vi.advanceTimersByTime(2000);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});
