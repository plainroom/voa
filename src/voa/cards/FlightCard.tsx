import { ArrowUpRight, CalendarPlus, ChevronDown, Plane } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/Button";
import { useTask } from "../ai/apple";
import { flight, type Trip } from "../ai/tasks/flight";
import { openLink } from "./calendar";
import type { CardProps } from "./MailCards";
import { addToCalendar } from "./flightIcs";

/** The flight card: one quiet grey panel, a line per trip of the booking (ida, volta), the actions under them. */
export function FlightCard({
  airline,
  code,
  trips,
  onAdd,
  onManage,
}: {
  airline: string;
  code: string;
  trips: Trip[];
  onAdd: () => void;
  onManage?: () => void;
}) {
  // The first trip (ida) open, the others (volta) a line that opens; each opens and closes alone.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set([0]));
  const toggle = (i: number) =>
    setOpened((s) => {
      const next = new Set(s);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  return (
    <section className="rounded-panel bg-trip px-5 pt-4 pb-5">
      <p className="text-meta font-medium text-ink-2">{airline}</p>
      <div className="divide-y divide-line">
        {trips.map((t, i) => (
          <div key={i} className="py-3">
            <button type="button" onClick={() => toggle(i)} aria-expanded={opened.has(i)} className="flex w-full items-center gap-2 py-1 text-left">
              <span className="flex-1">
                <span className="block text-title font-semibold text-ink">{t.title}</span>
                <span className="block text-body text-ink-2">
                  {t.day} · {t.departs}
                  {t.arrives && ` to ${t.arrives}`}
                </span>
              </span>
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                className={`text-ink-3 transition-transform duration-(--vm-fast) ${opened.has(i) ? "rotate-180" : ""}`}
              />
            </button>
            {opened.has(i) && (
              <div className="mt-3 flex items-center gap-4 pb-1">
                <Stop code={t.from} city={t.fromCity} time={t.departs} />
                <Arc label={length(t)} />
                <Stop code={t.to} city={t.toCity} time={t.arrives} end />
                <dl className="ml-2 grid shrink-0 grid-flow-col grid-rows-2 gap-x-6 border-l border-line pl-6">
                  {code && <dt className="text-meta font-medium text-ink-2">Booking</dt>}
                  {code && <dd className="text-title text-ink tabular-nums">{code}</dd>}
                  <dt className="text-meta font-medium text-ink-2">Flights</dt>
                  <dd className="text-title text-ink tabular-nums">{t.flights.join(" · ")}</dd>
                </dl>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        {onManage && (
          <Button variant="primary" onClick={onManage}>
            Manage booking <ArrowUpRight size={12} strokeWidth={1.75} />
          </Button>
        )}
        <Button onClick={onAdd}>
          <CalendarPlus size={13} strokeWidth={1.75} /> Add to calendar
        </Button>
      </div>
    </section>
  );
}

function Stop({ code, city, time, end = false }: { code: string; city: string; time: string; end?: boolean }) {
  // A fixed width, so every trip's arc is as long as the others'.
  return (
    <span className={`w-20 shrink-0 ${end ? "text-right" : ""}`}>
      <span className="block text-[28px] leading-8 font-semibold tracking-tight text-ink">{code}</span>
      <span className="block text-body text-ink-2 tabular-nums" title={city}>
        {time}
      </span>
    </span>
  );
}

/**
 * "5 h 10 min" from departure to arrival, as the clocks the mail writes say; empty without an arrival.
 * ponytail: clock times carry no zone, so a trip across zones is off by their difference; zones need an airport table.
 */
function length(t: Trip): string {
  if (t.end == null) return "";
  const min = Math.round((t.end - t.start) / 60000);
  if (min <= 0) return "";
  const h = Math.floor(min / 60);
  return [h && `${h} h`, min % 60 && `${min % 60} min`].filter(Boolean).join(" ");
}

/** The flight path: a soft arc with the plane at its start, what happens on the way under it. */
function Arc({ label }: { label: string }) {
  return (
    <span className="relative min-w-32 flex-1 text-trip-line">
      <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="h-9 w-full" aria-hidden>
        <path
          d="M6 36 Q100 -12 194 36"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="0.1 7"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <Plane size={16} strokeWidth={1.75} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-45 fill-current" />
      <span className="block text-center text-meta text-ink-2">{label}</span>
    </span>
  );
}

/** The flight card of a message, when the flight task finds a booking in it. */
export function FlightCardFor({ message, open }: CardProps) {
  const booking = useTask(flight, message, open);
  if (!booking) return null;
  const { manage } = booking;
  return (
    <div className="pb-4">
      <FlightCard
        airline={booking.airline}
        code={booking.code}
        trips={booking.trips}
        onAdd={() => void addToCalendar(booking, message.id).catch((err: unknown) => console.warn("add to calendar failed", err))}
        onManage={manage ? () => void openLink(manage) : undefined}
      />
    </div>
  );
}
