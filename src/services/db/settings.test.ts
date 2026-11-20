import { describe, it, expect, vi } from "vitest";

const execute = vi.fn();
vi.mock("./connection", () => ({ getDb: async () => ({ execute }) }));

const { setSetting } = await import("./settings");

describe("setSetting", () => {
  it("resolves when the row is written", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 1 });
    await expect(setSetting("k", "v")).resolves.toBeUndefined();
  });

  it("throws when no row was written, so the screen does not say it saved", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(setSetting("k", "v")).rejects.toThrow("Setting k was not saved");
  });
});
