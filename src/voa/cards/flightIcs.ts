import type { Booking } from "../ai/tasks/flight";
import { openIcs } from "./calendar";

const stamp = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
};
const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

/**
 * The booking as an .ics, one event per trip. Hours are floating (no zone): as the mail writes them.
 * ponytail: a trip across time zones lands at the departure's clock on both ends; zones need an airport table.
 */
export function bookingIcs(b: Booking, uid: string): string {
  const events = b.trips.map((t, i) =>
    [
      "BEGIN:VEVENT",
      `UID:${uid}-${i}@voa`,
      `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(t.start)}`,
      `DTEND:${stamp(t.end ?? t.start + 60 * 60 * 1000)}`,
      `SUMMARY:${esc(`${b.airline === "Flight" ? "Flight" : b.airline}: ${t.fromCity} to ${t.toCity}`)}`,
      `DESCRIPTION:${esc([t.flights.join(", "), t.stops.length ? `via ${t.stops.join(", ")}` : "", b.code ? `Booking ${b.code}` : ""].filter(Boolean).join("\n"))}`,
      `LOCATION:${esc(t.from)}`,
      "END:VEVENT",
    ].join("\r\n"),
  );
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//voa//trip//EN", ...events, "END:VCALENDAR", ""].join("\r\n");
}

/** The booking in Calendar. */
export const addToCalendar = (b: Booking, id: string) => openIcs(`trip-${id}`, bookingIcs(b, id));
