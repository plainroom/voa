import type { Shape, Task } from "../apple";
import type { MailText } from "../mailText";

/** One direction of a booking (ida, volta), as the card shows it; start and end as local clock times. */
export type Trip = {
  title: string;
  day: string;
  from: string;
  fromCity: string;
  departs: string;
  to: string;
  toCity: string;
  arrives: string;
  stops: string[];
  flights: string[];
  start: number;
  end: number | null;
};

/** A flight booking read from one mail: every value in it is written in that mail. */
export type Booking = {
  airline: string;
  code: string;
  trips: Trip[];
  manage: string | null;
};

type Raw = {
  isBooking?: unknown;
  code?: unknown;
  airline?: unknown;
  manage?: unknown;
  trips?: {
    from?: unknown;
    fromCity?: unknown;
    to?: unknown;
    toCity?: unknown;
    departs?: unknown;
    arrives?: unknown;
    flights?: unknown;
    stops?: unknown;
  }[];
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const IATA = /^[A-Z]{3}$/;
const FLIGHT = /^[A-Z0-9]{2}\d{1,4}$/;
const WHEN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/** "2026-12-18T06:10" as a local Date, when the mail writes that hour ("06:10" or "6:10"). */
function written(when: string, mail: string): Date | null {
  const m = WHEN.exec(when);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  if (!mail.includes(`${h}:${mi}`) && !mail.includes(`${Number(h)}:${mi}`)) return null;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(date.getTime()) ? null : date;
}

const dayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const hourFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * The model's answer kept only where the mail says it: a trip whose airports, flights or hours
 * are not written in the mail is dropped (the model fills a template it was shown, or guesses),
 * and nothing is shown when no trip is left.
 */
export function checkBooking(answer: unknown, { text: mail, links }: MailText): Booking | null {
  if (!answer || typeof answer !== "object") return null;
  const raw = answer as Raw;
  if (raw.isBooking === false) return null;
  const trips: Trip[] = [];
  for (const t of raw.trips ?? []) {
    const from = str(t.from);
    const to = str(t.to);
    const flights = strs(t.flights);
    const stops = strs(t.stops).filter((s) => IATA.test(s) && mail.includes(s));
    const departs = written(str(t.departs), mail);
    const arrives = written(str(t.arrives), mail); // an arrival the mail does not write is left out, the trip kept
    const ok =
      IATA.test(from) &&
      IATA.test(to) &&
      from !== to &&
      mail.includes(from) &&
      mail.includes(to) &&
      flights.length > 0 &&
      flights.every((f) => FLIGHT.test(f) && mail.includes(f)) &&
      departs;
    if (!ok) continue;
    const city = (v: unknown, code: string) => (str(v) && mail.includes(str(v)) ? str(v) : code);
    const fromCity = city(t.fromCity, from);
    const toCity = city(t.toCity, to);
    trips.push({
      title: `${fromCity} to ${toCity}`,
      day: dayFmt.format(departs),
      from,
      fromCity,
      departs: hourFmt.format(departs),
      to,
      toCity,
      arrives: arrives ? hourFmt.format(arrives) : "",
      stops,
      flights,
      start: departs.getTime(),
      end: arrives?.getTime() ?? null,
    });
  }
  if (!trips.length) return null;
  const code = str(raw.code);
  const airline = str(raw.airline);
  const n = typeof raw.manage === "number" ? raw.manage : 0;
  return {
    airline: airline && mail.includes(airline) ? airline : "Flight",
    code: /^[A-Z0-9]{5,8}$/.test(code) && mail.includes(code) ? code : "",
    trips,
    manage: links[n - 1] ?? null,
  };
}

const text = (name: string, description: string, optional = false): Shape => ({ type: "string", name, description, optional });

/** Whether a mail confirms a flight booking, and its trips (one per direction), each value as the mail writes it. */
export const flight: Task<Booking> = {
  id: "flight",
  version: 1,
  instructions:
    "You read one email. Say whether it confirms a flight booking (a ticket bought or a reservation made), and if so copy its booking code, airline, the link to manage it, and one trip per direction (ida, volta). Copy every value as the email writes it; never compute or guess one. Links are written as [link N].",
  schema: {
    type: "object",
    properties: [
      { type: "boolean", name: "isBooking", description: "True only if this email confirms a flight booking" },
      text("code", "Booking or reservation code (PNR)", true),
      text("airline", "Airline name", true),
      {
        type: "integer",
        name: "manage",
        description:
          "N of the [link N] whose words manage or change the booking (like Administrar minha viagem, Manage booking), never one to view the email in a browser; 0 if none",
        optional: true,
      },
      {
        type: "array",
        name: "trips",
        description: "One per direction; empty when not a booking",
        maxItems: 6,
        items: {
          type: "object",
          properties: [
            text("from", "Three-letter IATA code of the first departure airport, like CWB"),
            text("fromCity", "City of the first departure"),
            text("to", "Three-letter IATA code of the final arrival airport, like VIX"),
            text("toCity", "City of the final arrival"),
            text("departs", "First departure of this trip as YYYY-MM-DDTHH:MM, from the date and hour written"),
            text("arrives", "Final arrival of this trip as YYYY-MM-DDTHH:MM: the last date and hour written for it, at its last airport"),
            { type: "array", name: "flights", description: "Flight numbers of this trip, in order", items: { type: "string" } },
            { type: "array", name: "stops", description: "Three-letter IATA codes where the plane is changed", items: { type: "string" } },
          ],
        },
      },
    ],
  },
  check: checkBooking,
};
