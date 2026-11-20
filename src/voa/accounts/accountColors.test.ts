import { describe, it, expect } from "vitest";
import { ACCOUNT_COLORS, nextAccountColor } from "./accountColors";

describe("nextAccountColor", () => {
  it("starts with account-1", () => {
    expect(nextAccountColor([])).toBe("account-1");
  });

  it("returns the first unused color", () => {
    expect(nextAccountColor(["account-1"])).toBe("account-2");
    expect(nextAccountColor(["account-1", "account-3"])).toBe("account-2");
  });

  it("wraps around when all six are used", () => {
    expect(nextAccountColor([...ACCOUNT_COLORS])).toBe("account-1");
  });

  it("has six colors", () => {
    expect(ACCOUNT_COLORS).toHaveLength(6);
  });
});
