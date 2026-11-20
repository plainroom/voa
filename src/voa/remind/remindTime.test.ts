import { formatRemindTime, parseRemindTime, presetTime } from "./remindTime";

const now = new Date(2026, 10, 11, 10, 0); // Wednesday
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0);

describe("presetTime", () => {
  it("tonight is 18:00, or tomorrow's from 17:00 on", () => {
    expect(presetTime("tonight", now)).toEqual(at(11, 18));
    expect(presetTime("tonight", new Date(2026, 10, 11, 17, 30))).toEqual(at(12, 18));
  });

  it("tomorrow is 08:00 the next day", () => {
    expect(presetTime("tomorrow", now)).toEqual(at(12, 8));
  });

  it("weekend is next Saturday 09:00, the next one when it is already the weekend", () => {
    expect(presetTime("weekend", now)).toEqual(at(14, 9));
    expect(presetTime("weekend", new Date(2026, 10, 14, 8, 0))).toEqual(at(21, 9));
    expect(presetTime("weekend", new Date(2026, 10, 15, 8, 0))).toEqual(at(21, 9));
  });

  it("next week is next Monday 08:00", () => {
    expect(presetTime("nextWeek", now)).toEqual(at(16, 8));
    expect(presetTime("nextWeek", new Date(2026, 10, 16, 7, 0))).toEqual(at(23, 8));
  });
});

describe("parseRemindTime", () => {
  it("reads English and Portuguese, forward only", () => {
    expect(parseRemindTime("friday 2pm", now)).toEqual(at(13, 14));
    expect(parseRemindTime("sexta 14h", now)).toEqual(at(13, 14));
    expect(parseRemindTime("sexta às 9h30", now)).toEqual(new Date(2026, 10, 13, 9, 30));
    expect(parseRemindTime("in 3 days", now)).toEqual(at(14, 10));
  });

  it("is null when nothing parses or the time is not ahead", () => {
    expect(parseRemindTime("banana", now)).toBeNull();
    expect(parseRemindTime("yesterday", now)).toBeNull();
  });
});

describe("formatRemindTime", () => {
  it("is the weekday within a week, else the date, with a 24 h time", () => {
    expect(formatRemindTime(at(11, 18), now)).toBe("Wed 18:00");
    expect(formatRemindTime(at(16, 8), now)).toBe("Mon 08:00");
    expect(formatRemindTime(at(23, 8), now)).toBe("Nov 23 08:00");
  });
});
