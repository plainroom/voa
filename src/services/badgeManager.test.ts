import { beforeEach, describe, expect, it, vi } from "vitest";

const setBadgeLabel = vi.fn();
const invoke = vi.fn();
const getUnreadInboxCount = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setBadgeLabel }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./db/threads", () => ({
  getUnreadInboxCount: (...args: unknown[]) => getUnreadInboxCount(...args),
}));

describe("badgeManager", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetBadgeCache } = await import("./badgeManager");
    resetBadgeCache();
  });

  it("sets the Dock badge and tray tooltip when there is unread mail", async () => {
    getUnreadInboxCount.mockResolvedValue(3);
    const { updateBadgeCount } = await import("./badgeManager");

    await updateBadgeCount();

    expect(setBadgeLabel).toHaveBeenCalledWith("3");
    expect(invoke).toHaveBeenCalledWith("set_tray_tooltip", {
      tooltip: "voa - 3 unread",
    });
    expect(invoke).toHaveBeenCalledWith("set_tray_title", { title: "3" });
  });

  it("clears the Dock badge when the inbox is empty", async () => {
    getUnreadInboxCount.mockResolvedValue(0);
    const { updateBadgeCount } = await import("./badgeManager");

    await updateBadgeCount();

    expect(setBadgeLabel).toHaveBeenCalledWith("");
    expect(invoke).toHaveBeenCalledWith("set_tray_tooltip", { tooltip: "voa" });
    expect(invoke).toHaveBeenCalledWith("set_tray_title", { title: "" });
  });

  it("skips a second call with the same count", async () => {
    getUnreadInboxCount.mockResolvedValue(2);
    const { updateBadgeCount } = await import("./badgeManager");

    await updateBadgeCount();
    await updateBadgeCount();

    expect(setBadgeLabel).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the newer count when an older read finishes last", async () => {
    let releaseOlder: (count: number) => void = () => {};
    const older = new Promise<number>((resolve) => {
      releaseOlder = resolve;
    });
    getUnreadInboxCount.mockReturnValueOnce(older).mockResolvedValueOnce(0);
    const { updateBadgeCount } = await import("./badgeManager");

    const first = updateBadgeCount();
    const second = updateBadgeCount();
    releaseOlder(1);
    await first;
    await second;

    expect(setBadgeLabel).toHaveBeenLastCalledWith("");
  });
});
