import { formatRowDate } from "./formatRowDate";

describe("formatRowDate", () => {
  const now = new Date(2026, 10, 11, 15, 0); // Wed Nov 11 2026

  it("reads today as a time, this week as a weekday, older as a month and day", () => {
    expect(formatRowDate(new Date(2026, 10, 11, 9, 5).getTime(), now)).toMatch(/9:05/);
    expect(formatRowDate(new Date(2026, 10, 9, 9, 5).getTime(), now)).toBe("Mon");
    expect(formatRowDate(new Date(2026, 9, 14).getTime(), now)).toBe("Oct 14");
    expect(formatRowDate(new Date(2025, 9, 14).getTime(), now)).toBe("Oct 14, 2025");
  });
});
