import { describe, expect, it } from "vitest";
import { bookingIcs } from "../../cards/flightIcs";
import { checkBooking } from "./flight";

// The LATAM confirmation as the reader sees it (trimmed), and what Apple's model answered for it.
const LATAM =
  "Sua viagem a Vitória está pronta! Código de reserva: LETBVQ Administrar minha viagem [link 1] Voo de ida 18 de dez. de 2026 6:10 Curitiba (CWB) LA4709 Troca de avião em: São Paulo (GRU) LA3594 18 de dez. de 2026 11:20 Vitória (VIX) Voo de volta 28 de dez. de 2026 9:15 Vitória (VIX) LA3641 Troca de avião em: São Paulo (CGH) LA3062 28 de dez. de 2026 13:00 Curitiba (CWB) Equipe LATAM Airlines";
const ANSWER = `{"code": "LETBVQ", "airline": "LATAM", "manage": 1, "trips": [{"from": "CWB", "fromCity": "Curitiba", "to": "VIX", "toCity": "Vitória", "departs": "2026-12-18 06:10", "arrives": "2026-12-18 11:20", "flights": ["LA4709", "LA3594"], "stops": ["GRU"]}, {"from": "VIX", "fromCity": "Vitória", "to": "CWB", "toCity": "Curitiba", "departs": "2026-12-28 09:15", "arrives": "2026-12-28 13:00", "flights": ["LA3641", "LA3062"], "stops": ["CGH"]}]}`;

describe("checkBooking", () => {
  it("keeps a booking whose every value is written in the mail", () => {
    const b = checkBooking(JSON.parse(ANSWER), { text: LATAM, links: ["https://latam.example/manage"] });
    expect(b?.code).toBe("LETBVQ");
    expect(b?.manage).toBe("https://latam.example/manage");
    expect(b?.trips.map((t) => [t.title, t.departs, t.arrives, t.stops, t.flights])).toEqual([
      ["Curitiba to Vitória", "06:10", "11:20", ["GRU"], ["LA4709", "LA3594"]],
      ["Vitória to Curitiba", "09:15", "13:00", ["CGH"], ["LA3641", "LA3062"]],
    ]);
  });

  it("drops the template the model echoes on a mail that is no booking", () => {
    const uber = "Reserva confirmada para domingo. Sua viagem de Curitiba - PR até Estação de Curitiba às 22:30.";
    const junk = `{"code": "booking code", "airline": "Uber", "trips": [{"from": "IATA", "to": "IATA", "departs": "2023-10-01T10:00", "flights": ["LA0000"], "stops": ["IATA"]}]}`;
    expect(checkBooking(JSON.parse(junk), { text: uber, links: [] })).toBeNull();
    expect(checkBooking({ trips: [] }, { text: uber, links: [] })).toBeNull();
    expect(checkBooking("not an object", { text: uber, links: [] })).toBeNull();
  });

  it("leaves out an arrival the mail does not write, and drops a trip whose departure it does not", () => {
    const arrival = checkBooking(JSON.parse(ANSWER.replace("2026-12-18 11:20", "2026-12-18 08:45")), { text: LATAM, links: [] });
    expect(arrival?.trips.map((t) => [t.from, t.arrives])).toEqual([
      ["CWB", ""],
      ["VIX", "13:00"],
    ]);
    const departure = checkBooking(JSON.parse(ANSWER.replace("2026-12-18 06:10", "2026-12-18 07:45")), { text: LATAM, links: [] });
    expect(departure?.trips.map((t) => t.from)).toEqual(["VIX"]);
  });
});

it("writes one event per trip", () => {
  const ics = bookingIcs(checkBooking(JSON.parse(ANSWER), { text: LATAM, links: [] })!, "m1");
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(ics).toContain("DTSTART:20261218T061000");
  expect(ics).toContain("DTEND:20261218T112000");
});
