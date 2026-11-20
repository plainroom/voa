import { zeroState } from "./zeroState";

describe("zeroState", () => {
  it("null when the unified list still has mail", () => {
    expect(zeroState({ counts: { a: 0, b: 2 }, filter: null })).toBeNull();
  });

  it("allClear when every account is empty", () => {
    expect(zeroState({ counts: { a: 0, b: 0 }, filter: null })).toBe("allClear");
    expect(zeroState({ counts: {}, filter: null })).toBe("allClear");
  });

  it("allClear when the only account is empty", () => {
    expect(zeroState({ counts: { a: 0 }, filter: "a" })).toBe("allClear");
  });

  it("accountClear when the filtered account is empty and another has mail", () => {
    expect(zeroState({ counts: { a: 0, b: 3 }, filter: "a" })).toBe("accountClear");
  });

  it("null when the filtered account still has mail", () => {
    expect(zeroState({ counts: { a: 1, b: 0 }, filter: "a" })).toBeNull();
  });
});
