import { describe, it, expect } from "vitest";
import { groupByTime } from "./groupByTime";

const id = (t: number) => t;

describe("groupByTime", () => {
  it("groups into Today, Yesterday, This week and months", () => {
    const now = new Date(2026, 10, 11, 10, 0); // Wed 2026-11-11 10:00
    const items = [
      new Date(2026, 10, 11, 8, 0).getTime(),
      new Date(2026, 10, 10, 20, 0).getTime(),
      new Date(2026, 10, 9, 9, 0).getTime(), // Monday
      new Date(2026, 10, 2, 9, 0).getTime(),
      new Date(2026, 9, 30, 9, 0).getTime(),
      new Date(2025, 11, 1, 9, 0).getTime(),
    ];
    const groups = groupByTime(items, id, now);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "This week",
      "November",
      "October",
      "December 2025",
    ]);
    expect(groups.every((g) => g.items.length === 1)).toBe(true);
  });

  it("on a Monday, yesterday's item is Yesterday, not This week", () => {
    const now = new Date(2026, 10, 9, 10, 0); // Mon
    const groups = groupByTime([new Date(2026, 10, 8, 12, 0).getTime()], id, now);
    expect(groups.map((g) => g.label)).toEqual(["Yesterday"]);
  });

  it("omits empty groups and keeps order within a group", () => {
    const now = new Date(2026, 10, 11, 10, 0);
    const a = new Date(2026, 10, 11, 9, 0).getTime();
    const b = new Date(2026, 10, 11, 7, 0).getTime();
    const groups = groupByTime([a, b], id, now);
    expect(groups).toEqual([{ label: "Today", items: [a, b] }]);
  });

  it("uses the accessor for non-numeric items", () => {
    const now = new Date(2026, 10, 11, 10, 0);
    const item = { when: new Date(2026, 10, 11, 9, 0).getTime() };
    expect(groupByTime([item], (i) => i.when, now)[0]!.label).toBe("Today");
  });
});
