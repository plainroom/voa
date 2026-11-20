import { describe, expect, it } from "vitest";
import { readInvite, replyIcs, replyMail } from "./invite";

// The shape Google Calendar sends (trimmed): a zone, a folded line, three guests, a Meet link.
const ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/Sao_Paulo",
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Sao_Paulo:20261124T200000",
  "DTEND;TZID=America/Sao_Paulo:20261124T220000",
  "ORGANIZER;CN=Raphael Rocha:mailto:raphael@example.com",
  "UID:abc123@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=me@exam",
  " ple.com:mailto:me@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Raphael Rocha:mailto:raphael@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@example.com",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Aula Odisseia\\, Brasileira",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("readInvite", () => {
  it("reads the event in its zone, who invited, the guests, the owner's answer and the Meet link", () => {
    const inv = readInvite(ICS, "Me@Example.com")!;
    expect(inv.title).toBe("Aula Odisseia, Brasileira");
    expect(new Date(inv.start).toISOString()).toBe("2026-11-24T23:00:00.000Z");
    expect(new Date(inv.end!).toISOString()).toBe("2026-11-25T01:00:00.000Z");
    expect(inv.organizer).toEqual({ name: "Raphael Rocha", email: "raphael@example.com" });
    expect(inv.guests).toBe(3);
    expect(inv.reply).toBeNull();
    expect(inv.join).toBe("https://meet.google.com/abc-defg-hij");
    expect(inv.cancelled).toBe(false);
  });

  it("reads an answer already given, a cancellation, and nothing without an event", () => {
    expect(readInvite(ICS.replace("PARTSTAT=NEEDS-ACTION;CN=me", "PARTSTAT=ACCEPTED;CN=me"), "me@example.com")?.reply).toBe("yes");
    expect(readInvite(ICS.replace("METHOD:REQUEST", "METHOD:CANCEL"), "me@example.com")?.cancelled).toBe(true);
    expect(readInvite("BEGIN:VCALENDAR\r\nEND:VCALENDAR", "me@example.com")).toBeNull();
    expect(readInvite(ICS, "me@example.com")?.answered).toBeNull();
  });
});

it("replies with the event's own lines and the owner's answer, to the organizer", () => {
  const inv = readInvite(ICS, "me@example.com")!;
  const me = { name: "Vagner", email: "me@example.com" };
  const ics = replyIcs(inv, "maybe", me, Date.UTC(2026, 10, 16));
  expect(ics).toContain("METHOD:REPLY");
  expect(ics).toContain("UID:abc123@google.com");
  expect(ics).toContain("DTSTART;TZID=America/Sao_Paulo:20261124T200000");
  expect(ics).toContain('ATTENDEE;PARTSTAT=TENTATIVE;CN="Vagner":mailto:me@example.com');
  const mail = atob(replyMail(inv, "yes", me).replace(/-/g, "+").replace(/_/g, "/"));
  expect(mail).toContain("To: <raphael@example.com>");
  expect(mail).toContain("method=REPLY");
});

it("reads a guest's reply as who answered what, not as an invitation", () => {
  const inv = readInvite(ICS, "me@example.com")!;
  const reply = readInvite(replyIcs(inv, "yes", { name: "Vagner", email: "me@example.com" }), "raphael@example.com");
  expect(reply?.answered).toEqual({ name: "Vagner", reply: "yes" });
});
