/**
 * A calendar invitation (an .ics attached to a mail, RFC 5545), read exactly: no model. And the
 * reply to one (iTIP REPLY, RFC 5546), which Google Calendar and Outlook take as the guest's answer.
 */

export type Reply = "yes" | "maybe" | "no";

export type Invite = {
  uid: string;
  sequence: string;
  title: string;
  start: number;
  end: number | null;
  allDay: boolean;
  organizer: { name: string; email: string } | null;
  guests: number;
  /** The owner's own answer in the invitation, when they are one of its guests. */
  reply: Reply | null;
  join: string | null;
  cancelled: boolean;
  /** A guest's answer to the owner's invitation (METHOD:REPLY): who, and what. Nothing to answer then. */
  answered: { name: string; reply: Reply } | null;
  /** The lines the reply copies as they came (DTSTART, ORGANIZER, SUMMARY, ...). */
  raw: Record<string, string>;
};

type Line = { name: string; params: Record<string, string>; value: string; raw: string };

/** Content lines, unfolded (a line starting with a space or a tab continues the one before). */
function lines(ics: string): Line[] {
  return ics
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((raw) => {
      const colon = raw.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const head = colon < 0 ? raw : raw.slice(0, colon);
      const [name = "", ...params] = head.split(";");
      return {
        name: name.toUpperCase(),
        params: Object.fromEntries(params.map((p) => [p.slice(0, p.indexOf("=")).toUpperCase(), p.slice(p.indexOf("=") + 1).replace(/^"|"$/g, "")])),
        value: colon < 0 ? "" : raw.slice(colon + 1),
        raw,
      };
    });
}

const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

/** Milliseconds a zone is ahead of UTC at `t`; throws for a zone the system does not know. */
function offset(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(t);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(t / 1000) * 1000;
}

/** DTSTART/DTEND as an instant: UTC (Z), a TZID's wall clock, or floating (this Mac's clock). */
function when(l: Line): { at: number; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(l.value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { at: new Date(Number(y), Number(mo) - 1, Number(d)).getTime(), allDay: true };
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (z) return { at: wall, allDay: false };
  const zone = l.params.TZID;
  if (zone) {
    try {
      const first = wall - offset(wall, zone);
      return { at: wall - offset(first, zone), allDay: false };
    } catch {
      // ponytail: a zone Intl does not know (Outlook's Windows names) is read as this Mac's clock; its VTIMEZONE could say better.
    }
  }
  return { at: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime(), allDay: false };
}

const mailto = (v: string) => v.replace(/^mailto:/i, "").toLowerCase();
const REPLIES: Record<string, Reply> = { ACCEPTED: "yes", TENTATIVE: "maybe", DECLINED: "no" };

/** The first event of an invitation, as seen by `owner` (their address), or null when there is none to show. */
export function readInvite(ics: string, owner: string): Invite | null {
  const all = lines(ics);
  const method = all.find((l) => l.name === "METHOD")?.value.toUpperCase();
  const begin = all.findIndex((l) => l.name === "BEGIN" && l.value.toUpperCase() === "VEVENT");
  if (begin < 0) return null;
  const end = all.findIndex((l, i) => i > begin && l.name === "END" && l.value.toUpperCase() === "VEVENT");
  const event = all.slice(begin + 1, end < 0 ? undefined : end);
  const one = (name: string) => event.find((l) => l.name === name);
  const start = one("DTSTART") && when(one("DTSTART")!);
  const uid = one("UID")?.value;
  if (!start || !uid) return null;
  const finish = one("DTEND") && when(one("DTEND")!);
  const org = one("ORGANIZER");
  const guests = event.filter((l) => l.name === "ATTENDEE");
  const me = guests.find((l) => mailto(l.value) === owner.toLowerCase());
  const urls = [one("X-GOOGLE-CONFERENCE"), one("X-MICROSOFT-SKYPETEAMSMEETINGURL"), one("LOCATION"), one("URL")].map((l) => l?.value.trim() ?? "");
  return {
    uid,
    sequence: one("SEQUENCE")?.value ?? "0",
    title: unescape(one("SUMMARY")?.value ?? "") || "(no title)",
    start: start.at,
    end: finish?.at ?? null,
    allDay: start.allDay,
    organizer: org ? { name: org.params.CN ?? "", email: mailto(org.value) } : null,
    guests: guests.length,
    reply: me ? (REPLIES[me.params.PARTSTAT?.toUpperCase() ?? ""] ?? null) : null,
    join: urls.find((u) => /^https:\/\//i.test(u)) ?? null,
    cancelled: method === "CANCEL" || one("STATUS")?.value.toUpperCase() === "CANCELLED",
    answered: method === "REPLY" ? answerOf(guests) : null,
    raw: Object.fromEntries(event.filter((l) => ["DTSTART", "DTEND", "ORGANIZER", "SUMMARY", "RECURRENCE-ID"].includes(l.name)).map((l) => [l.name, l.raw])),
  };
}

/** The guest a reply speaks for (a reply carries one) and their answer; null when it says none of the three. */
function answerOf(guests: Line[]): { name: string; reply: Reply } | null {
  const g = guests[0];
  const reply = g && REPLIES[g.params.PARTSTAT?.toUpperCase() ?? ""];
  return g && reply ? { name: g.params.CN || mailto(g.value), reply } : null;
}

const PARTSTAT: Record<Reply, string> = { yes: "ACCEPTED", maybe: "TENTATIVE", no: "DECLINED" };
const VERB: Record<Reply, string> = { yes: "Accepted", maybe: "Tentatively accepted", no: "Declined" };

const stamp = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** The reply to an invitation as the .ics its organizer's calendar reads (METHOD:REPLY). */
export function replyIcs(inv: Invite, reply: Reply, me: { name: string; email: string }, now = Date.now()): string {
  const cn = me.name ? `;CN="${me.name.replace(/"/g, "")}"` : "";
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//voa//invite//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${inv.uid}`,
    `SEQUENCE:${inv.sequence}`,
    `DTSTAMP:${stamp(now)}`,
    ...["DTSTART", "DTEND", "RECURRENCE-ID", "ORGANIZER", "SUMMARY"].flatMap((k) => (inv.raw[k] ? [inv.raw[k]] : [])),
    `ATTENDEE;PARTSTAT=${PARTSTAT[reply]}${cn}:mailto:${me.email}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** The reply as a whole mail (base64url RFC 822, what every provider's send takes), to the organizer. */
export function replyMail(inv: Invite, reply: Reply, me: { name: string; email: string }, now = Date.now()): string {
  const subject = `${VERB[reply]}: ${inv.title}`;
  const words = `${me.name || me.email} ${VERB[reply].toLowerCase()} this invitation.`;
  const b = `voa-${now.toString(36)}`;
  const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const mail = [
    `From: ${me.name ? `"${me.name.replace(/"/g, "")}" ` : ""}<${me.email}>`,
    `To: <${inv.organizer!.email}>`,
    `Subject: =?UTF-8?B?${enc(subject)}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    enc(words),
    `--${b}`,
    "Content-Type: text/calendar; charset=UTF-8; method=REPLY",
    "Content-Transfer-Encoding: base64",
    "",
    enc(replyIcs(inv, reply, me, now)),
    `--${b}--`,
    "",
  ].join("\r\n");
  return btoa(mail).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
