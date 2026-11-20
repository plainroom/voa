import * as chrono from "chrono-node";

export type RemindPreset = "tonight" | "tomorrow" | "weekend" | "nextWeek";

const SATURDAY = 6;
const MONDAY = 1;

function dayAt(now: Date, daysAhead: number, hour: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, hour, 0);
}

/** Days until the next `weekday`, never today. */
const daysUntil = (now: Date, weekday: number) => (weekday - now.getDay() + 7) % 7 || 7;

/** The Remind me presets, in local time. */
export function presetTime(preset: RemindPreset, now: Date): Date {
  switch (preset) {
    case "tonight":
      return dayAt(now, now.getHours() >= 17 ? 1 : 0, 18);
    case "tomorrow":
      return dayAt(now, 1, 8);
    case "weekend":
      // On a Saturday or a Sunday this weekend is already here: the next one.
      return dayAt(now, now.getDay() === 0 ? 6 : daysUntil(now, SATURDAY), 9);
    case "nextWeek":
      return dayAt(now, daysUntil(now, MONDAY), 8);
  }
}


/** Portuguese with "14h", "às 9h30": the Brazilian way of writing an hour, which chrono's pt does not read. */
const pt = chrono.pt.casual.clone();
pt.parsers.push({
  pattern: () => /(?:às\s+)?(\d{1,2})h(\d{2})?(?!\w)/i,
  extract: (context, match) => {
    if (/\d/.test(context.text[(match.index ?? 0) - 1] ?? "")) return null; // "125h" is no hour
    const hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    return hour < 24 && minute < 60 ? { hour, minute } : null;
  },
});

/**
 * A time written by the owner ("friday 2pm", "sexta 14h", "in 3 days"), or null when none is read
 * or it is not ahead. English and Portuguese both read the text; the one that read more of it wins
 * (English alone takes "14h" for something else).
 */
export function parseRemindTime(text: string, now: Date): Date | null {
  const reads = [chrono.en.casual, pt].flatMap((c) => c.parse(text, now, { forwardDate: true }).slice(0, 1));
  const best = reads.reduce<(typeof reads)[number] | null>((a, r) => (!a || r.text.length > a.text.length ? r : a), null);
  const date = best?.start.date();
  return date && date > now ? date : null;
}

const hourMinute = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** When a snoozed thread comes back: "Thu 18:00" within a week, else "Nov 23 08:00". */
export function formatRemindTime(at: Date, now: Date): string {
  const inAWeek = dayAt(now, 7, 0);
  return `${at < inAWeek ? weekday.format(at) : monthDay.format(at)} ${hourMinute.format(at)}`;
}
