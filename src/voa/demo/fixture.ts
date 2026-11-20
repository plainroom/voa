/**
 * Browser-only demo of the inbox (`npm run dev`, then http://localhost:1420/?demo=1): two fake
 * accounts and a handful of threads, kept in memory. main.tsx loads this file only in a dev
 * build, outside Tauri, with ?demo=1; it refuses to run inside the app.
 */
import type { DbMessage } from "@/services/db/messages";
import type { DbThread, ThreadKey } from "@/services/db/threads";
import { parseSearchQuery } from "@/services/search/searchParser";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { demoAI } from "../ai/demo";
import type { InboxList } from "@/stores/list";
import type { InboxAccount, InboxSource } from "../inbox/source";
import { photoOfDay, photos } from "../zero/photos";
import { stashDraft } from "../compose/draftStash";

if ("__TAURI_INTERNALS__" in window) throw new Error("The voa demo never runs inside the app");

const ACCOUNTS: InboxAccount[] = [
  { id: "personal", name: "Personal", email: "me@example.com", color: "account-1", synced: true },
  { id: "work", name: "Work", email: "me@work.example", color: "account-2", synced: true },
];

const now = new Date();
const at = (daysAgo: number, hour: number, minute = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute).getTime();
/** A day earlier this week, but never today or yesterday (falls back to two days ago). */
const thisWeek = (hour: number) => at(Math.max(2, (now.getDay() + 6) % 7), hour);
const lastMonth = (day: number, hour: number) => new Date(now.getFullYear(), now.getMonth() - 1, day, hour).getTime();

const FLIGHT = "Your flight to Lisbon is confirmed";

type Seed = [account: string, from: string, subject: string, snippet: string, when: number, unread: boolean, labels: string[]];

const SEEDS: Seed[] = [
  ["work", "Marina Costa", "Revised proposal", "Hi, here is the version with the changes we talked about on Monday. Let me know if the numbers work.", at(0, 10, 42), true, ["INBOX"]],
  ["personal", "Northbank", "Your statement is ready", "Your November statement is available in the app and attached as a PDF.", at(0, 9, 15), true, ["INBOX"]],
  ["work", "Rafael Lima", "Thursday meeting", "Can we move it to 3pm? Something came up in the morning and I would rather not rush it.", at(0, 8, 3), false, ["INBOX"]],
  ["personal", "Staywell", "Your trip to Lisbon is coming up", "Check-in is in two weeks. Here is everything you need for your stay.", at(0, 7, 30), false, ["INBOX"]],
  ["personal", "Ana Dutra", "Trip photos", "Put everything in the shared folder, the ones from the beach came out great.", at(1, 21, 12), false, ["INBOX"]],
  ["work", "Forge", "PR approved: voa#214", "lucasprado approved your pull request. Merge when ready.", at(1, 18, 40), false, ["INBOX"]],
  ["work", "Lucas Prado", "Contract signed", "All set, signed it this morning. Sending the copy for your records.", at(1, 11, 5), true, ["INBOX"]],
  ["personal", "Clara Mendes", "Dinner on Saturday?", "We are thinking of trying the new place near the park. Are you in?", thisWeek(19), false, ["INBOX"]],
  ["work", "Pagebook", "Weekly digest", "3 pages were updated in your workspace this week.", thisWeek(9), false, ["INBOX"]],
  ["work", "Fernanda Rocha", "Q4 planning notes", "Attached are the notes from today. The main open item is hiring for the platform team.", thisWeek(15), false, ["INBOX"]],
  ["personal", "Orchard", "Your receipt from Orchard", "Receipt for Orchard Cloud with 200 GB, billed to your card ending in 4421.", lastMonth(28, 14), false, ["INBOX"]],
  ["work", "Pedro Alves", "Re: onboarding checklist", "Added the access requests to the list. The laptop arrives on Monday.", lastMonth(22, 10), false, ["INBOX"]],
  ["personal", "Lumen", "Your photo got 10,000 views", "Congratulations! Your photo of the Serra da Mantiqueira is trending.", lastMonth(15, 16), false, ["INBOX"]],
  ["personal", "Juliana Prates", "Book club: next pick", "I vote for the Ishiguro. Whoever has not read it has a month.", lastMonth(9, 20), false, ["INBOX"]],
  ["work", "Paystream", "Payout sent", "A payout of R$ 12.480,00 is on its way to your bank account.", lastMonth(4, 8), false, ["INBOX"]],
  ["personal", "noreply", "Coursely | 515766 is your login code", "Use this code to sign in. It expires in 10 minutes.", at(0, 11, 24), true, ["INBOX"]],
  ["work", "Trackline", "Login for Trackline", "To login to Trackline, copy the verification code into your browser: CNR2NHJIM5", at(0, 11, 12), true, ["INBOX"]],
  ["personal", "Entrega Já", "Confirme a sua conta da Entrega Já", "Código de verificação Este é o código para verificar sua entrada na Entrega Já e vale por 1 hora. 610207", at(0, 11, 2), false, ["INBOX"]],
  ["personal", "Mercadinho.com.br", "Código de verificação Mercadinho.com.br", "HKQHXB é o seu código de validação. Basta copiar e colar.", at(0, 10, 58), false, ["INBOX"]],
  ["work", "Painel Norte", "Entrar no Painel Norte", "Use o código abaixo para acessar seu painel. 082885 O código expira em 1 hora.", at(0, 10, 50), true, ["INBOX"]],
  ["work", "Banco Aurora", "Login verificação em dois fatores", "Digite o código abaixo no portal. Seu código de verificação: 194830", at(0, 10, 46), false, ["INBOX"]],
  ["personal", "Beatriz Lopes", "Recipe you asked for", "Here it is. The trick is to toast the rice before adding the stock.", at(3, 12), false, ["STARRED"]],
  ["work", "Diego Martins", "Board deck feedback", "A few comments on slides 4 and 9, nothing blocking.", at(9, 17), false, ["STARRED"]],
  ["work", "Corre", "Até 40% off neste fim de semana", "Só até domingo nos tênis que você viu.", at(0, 6, 40), true, ["INBOX", "CATEGORY_PROMOTIONS"]],
  ["personal", "Fominha", "R$ 20 no seu próximo pedido", "Cupom valendo hoje no almoço.", at(0, 6, 10), false, ["INBOX", "CATEGORY_PROMOTIONS"]],
  ["work", "Lojão", "Oferta relâmpago", "Frete grátis por algumas horas em eletrônicos.", at(1, 8, 12), false, ["INBOX", "CATEGORY_PROMOTIONS"]],
  ["personal", "Skyline Air", FLIGHT, "Booking K7XQ2M. São Paulo to Lisbon, departing in three weeks.", at(0, 7, 50), true, ["INBOX"]],
];

const threads: DbThread[] = SEEDS.map(([account, from, subject, snippet, when, unread, seeded], i) => ({
  id: `t${i + 1}`,
  account_id: account,
  subject,
  snippet,
  last_message_at: when,
  message_count: 1,
  is_read: unread ? 0 : 1,
  is_starred: seeded?.includes("STARRED") ? 1 : 0,
  is_important: 0,
  has_attachments: 0,
  is_snoozed: 0,
  snooze_until: null,
  is_pinned: 0,
  is_muted: 0,
  from_name: from,
  from_address: null,
}));
const labels = new Map(SEEDS.map((s, i) => [`${s[0]}:t${i + 1}`, new Set(s[6])]));

// ?demo=zero starts with an empty inbox (the stars stay).
// ?demo=offline keeps the stored mail and only marks the machine offline.
const mode = new URLSearchParams(window.location.search).get("demo");
if (mode === "zero") for (const set of labels.values()) set.delete("INBOX");
// ?demo=site is the website's animation (site/): a short inbox that a few keys take to zero, a flight among it.
const SITE = new Set(["Revised proposal", FLIGHT, "Contract signed", "Dinner on Saturday?"]);
if (mode === "site") SEEDS.forEach((s, i) => !SITE.has(s[2]) && labels.get(`${s[0]}:t${i + 1}`)?.delete("INBOX"));
if (mode === "offline") {
  useUIStore.getState().setOnline(false);
}

const labelsOf = (k: ThreadKey) => labels.get(`${k.accountId}:${k.threadId}`) ?? new Set<string>();
const has = (t: DbThread, list: InboxList) => {
  const l = labelsOf({ accountId: t.account_id, threadId: t.id });
  return list === "DONE" ? !["INBOX", "SPAM", "TRASH", "SNOOZED"].some((x) => l.has(x)) : l.has(list);
};
const isPromotion = (t: DbThread) => labelsOf({ accountId: t.account_id, threadId: t.id }).has("CATEGORY_PROMOTIONS");
const inTrash = (t: DbThread) => labelsOf({ accountId: t.account_id, threadId: t.id }).has("TRASH");
const senderAddress = (t: DbThread) => `${(t.from_name ?? "unknown").toLowerCase().replace(/\W+/g, ".")}@example.com`;
const blocked = new Set<string>();
const hiddenInInbox = (t: DbThread) => blocked.has(`${t.account_id}\0${senderAddress(t)}`);

const BODIES: Record<string, string[]> = {
  t1: [
    "<p>Hi,</p><p>Here is the version with the changes we talked about on Monday. The big difference is the timeline: we moved the first milestone two weeks earlier, and the budget now reflects the second phase separately.</p><p><a href=\"https://example.com/proposal\">Open the proposal</a></p><p>Let me know if the numbers work for you. If they do, I can send the final PDF today.</p><p>Marina</p>",
  ],
  t3: [
    "<p>Hey, are we still on for Thursday at 2?</p>",
    "<p>Yes, 2 works. I will bring the draft.</p>",
    "<p>Can we move it to 3pm? Something came up in the morning and I would rather not rush it.</p><p>Rafael</p>",
  ],
  t5: [
    "<p>Put everything in the shared folder, the ones from the beach came out great.</p><p>I also added the video from the boat. It is long, skip to the part with the dolphins.</p><p>Ana</p>",
  ],
  t7: [
    "<p>All set, signed it this morning. Sending the copy for your records.</p>",
    "<p>Thank you, Lucas. I will file it today.</p>",
  ],
};
const fallbackBody = (t: DbThread) => `<p>${t.snippet}</p><p>Thanks,<br>${t.from_name}</p>`;

let lastFrom: string | null = null;

export const demoSource: InboxSource = {
  accounts: async () => ACCOUNTS,
  threads: async (list, accountIds) =>
    threads
      .filter((t) => has(t, list) && (list === "TRASH" || !inTrash(t)) && (!accountIds || accountIds.includes(t.account_id)) && (list !== "INBOX" || (!hiddenInInbox(t) && !isPromotion(t))))
      .sort((a, b) => b.last_message_at! - a.last_message_at!),
  promotions: async () =>
    threads
      .filter((t) => has(t, "INBOX") && isPromotion(t) && !hiddenInInbox(t) && !inTrash(t))
      .sort((a, b) => b.last_message_at! - a.last_message_at!),
  thread: async (k) => threads.find((t) => t.account_id === k.accountId && t.id === k.threadId),
  counts: async (list) => {
    const out: Record<string, number> = {};
    if (list === "DONE") return out;
    for (const t of threads) {
      if (!has(t, list) || inTrash(t) || (list === "INBOX" && (hiddenInInbox(t) || isPromotion(t)))) continue;
      out[t.account_id] = (out[t.account_id] ?? 0) + 1;
    }
    return out;
  },
  archive: async (k) => void labelsOf(k).delete("INBOX"),
  archiveMany: async (keys) => {
    for (const k of keys) labelsOf(k).delete("INBOX");
  },
  unarchive: async (k) => void labelsOf(k).add("INBOX"),
  trash: async (k) => {
    labelsOf(k).delete("INBOX");
    labelsOf(k).delete("SPAM");
    labelsOf(k).add("TRASH");
  },
  trashMany: async (keys) => {
    for (const k of keys) {
      labelsOf(k).delete("INBOX");
      labelsOf(k).delete("SPAM");
      labelsOf(k).add("TRASH");
    }
  },
  untrash: async (k, restore = "SPAM") => {
    labelsOf(k).delete("TRASH");
    if (restore) labelsOf(k).add(restore);
  },
  star: async (k, starred) => {
    if (starred) labelsOf(k).add("STARRED");
    else labelsOf(k).delete("STARRED");
    const t = threads.find((x) => x.account_id === k.accountId && x.id === k.threadId);
    if (t) t.is_starred = starred ? 1 : 0;
  },
  reconnect: async () => {},
  messages: async (k) => {
    const t = threads.find((x) => x.account_id === k.accountId && x.id === k.threadId);
    if (!t) return [];
    const bodies = BODIES[t.id] ?? [fallbackBody(t)];
    const me = ACCOUNTS.find((a) => a.id === t.account_id)!;
    return bodies.map((html, i): DbMessage => {
      const mine = bodies.length > 1 && i % 2 === 1;
      return {
        id: `${t.id}-m${i}`,
        account_id: t.account_id,
        thread_id: t.id,
        from_address: mine ? me.email : `${t.from_name!.toLowerCase().replace(/\W+/g, ".")}@example.com`,
        from_name: mine ? "Me" : t.from_name,
        to_addresses: mine ? "" : me.email,
        cc_addresses: null,
        bcc_addresses: null,
        reply_to: null,
        subject: t.subject,
        snippet: t.snippet,
        date: t.last_message_at! - (bodies.length - 1 - i) * 3_600_000,
        is_read: 1,
        is_starred: 0,
        body_html: html,
        body_text: null,
        body_cached: 1,
        body_pending: 0,
        raw_size: null,
        internal_date: null,
        list_unsubscribe: t.id === "t9" ? "<mailto:unsub@example.com>, <https://example.com/unsub>" : null,
        list_unsubscribe_post: t.id === "t9" ? "List-Unsubscribe=One-Click" : null,
        auth_results: null,
        message_id_header: null,
        references_header: null,
        in_reply_to_header: null,
        imap_uid: null,
        imap_folder: null,
      };
    });
  },
  markRead: async (k) => {
    const row = threads.find((t) => t.account_id === k.accountId && t.id === k.threadId);
    if (row) row.is_read = 1;
  },
  imagePolicy: async () => ({ block: false, allowed: new Set() }),
  attachments: async () => [],
  openAttachment: async () => {}, // the demo has no files to open
  search: async (query) => {
    const { freeText, from, subject } = parseSearchQuery(query);
    const has = (value: string | null, needle?: string) => !needle || (value ?? "").toLowerCase().includes(needle.toLowerCase());
    return threads
      .filter((t) => has(t.from_name, from) && has(t.subject, subject) && has(`${t.from_name} ${t.subject} ${t.snippet}`, freeText))
      .sort((a, b) => b.last_message_at! - a.last_message_at!)
      .map((t) => ({
        accountId: t.account_id,
        threadId: t.id,
        from: t.from_name ?? "Unknown sender",
        subject: t.subject ?? "(no subject)",
        snippet: t.snippet ?? "",
        date: t.last_message_at!,
      }));
  },
  searchRemote: async () => {}, // the demo has no mailboxes to ask
  fetchBodies: async () => {}, // every demo body is there
  send: async () => {}, // the demo sends nothing: the screen's toast is all there is
  lastFromAccount: async () => lastFrom,
  setLastFromAccount: async (id) => void (lastFrom = id),
  spam: async (k) => {
    labelsOf(k).delete("INBOX");
    labelsOf(k).add("SPAM");
  },
  unspam: async (k) => {
    labelsOf(k).delete("SPAM");
    labelsOf(k).add("INBOX");
  },
  unsubscribe: async () => {},
  block: async (k) => {
    const current = threads.find((t) => t.account_id === k.accountId && t.id === k.threadId);
    const address = current ? senderAddress(current) : "";
    if (!address) throw new Error("No sender");
    blocked.add(`${k.accountId}\0${address}`);
    const touched: ThreadKey[] = [];
    for (const t of threads) {
      const key = { accountId: t.account_id, threadId: t.id };
      if (t.account_id === k.accountId && senderAddress(t) === address && labelsOf(key).has("INBOX")) {
        labelsOf(key).delete("INBOX");
        touched.push(key);
      }
    }
    return { address, threads: touched };
  },
  unblock: async (accountId, address) => void blocked.delete(`${accountId}\0${address}`),
  remind: async (k, until) => {
    labelsOf(k).delete("INBOX");
    labelsOf(k).add("SNOOZED");
    const row = threads.find((t) => t.account_id === k.accountId && t.id === k.threadId);
    if (row) Object.assign(row, { is_snoozed: 1, snooze_until: until });
  },
  unremind: async (k) => {
    labelsOf(k).delete("SNOOZED");
    labelsOf(k).add("INBOX");
    const row = threads.find((t) => t.account_id === k.accountId && t.id === k.threadId);
    if (row) Object.assign(row, { is_snoozed: 0, snooze_until: null });
  },
};

// The site's inbox zero (its animation and its still) is always the peaks over the clouds, the photo its hero draws in lines.
if (mode === "site" || mode === "zero") {
  const today = photos.indexOf(photoOfDay(now));
  const peaks = photos.findIndex((p) => p.src.includes("1506905925346"));
  if (today >= 0 && peaks >= 0) [photos[today], photos[peaks]] = [photos[peaks]!, photos[today]!];
}
if (mode === "site") {
  const later = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
  const flightId = `t${SEEDS.findIndex((x) => x[2] === FLIGHT) + 1}`;
  // The booking three weeks out: São Paulo tonight's flight lands in Lisbon the next afternoon.
  const leaves = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 21, 23, 40);
  const lands = new Date(leaves.getFullYear(), leaves.getMonth(), leaves.getDate() + 1, 13, 5);
  const day = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  BODIES[flightId] = [
    `<p>Hi Alex,</p><p>Your booking is confirmed. Booking code: <b>K7XQ2M</b></p><p><b>${day(leaves)}</b><br>TP88 · São Paulo (GRU) 23:40 to Lisbon (LIS) 13:05 (+1)</p><p>Seat 14A · 1 checked bag</p><p>Have a good flight,<br>Skyline Air</p>`,
  ];
  const booking = {
    airline: "Skyline Air",
    code: "K7XQ2M",
    manage: null,
    trips: [
      {
        title: "São Paulo to Lisbon",
        day: day(leaves),
        from: "GRU",
        fromCity: "São Paulo",
        departs: "23:40",
        to: "LIS",
        toCity: "Lisbon",
        arrives: "13:05",
        stops: [],
        flights: ["TP88"],
        start: leaves.getTime(),
        end: lands.getTime(),
      },
    ],
  };
  const summary = {
    gist: "Marina sent the revised proposal and needs your OK on the numbers.",
    points: ["The first milestone moved two weeks earlier.", "The budget shows the second phase separately.", "The final PDF can go out today."],
    action: "Tell Marina whether the numbers work.",
  };
  demoAI.ask = (task, subject) =>
    later(task === "flight" ? 300 : 1400, task === "summary" && subject.thread_id === "t1" ? summary : task === "flight" && subject.thread_id === flightId ? booking : null);
  demoAI.labels = new Map([
    ["work:t1", { kind: "work", respond: true }],
    [`personal:${flightId}`, { kind: "travel", respond: false }],
    ["work:t7", { kind: "work", respond: false }],
    ["personal:t8", { kind: "personal", respond: true }],
  ]);
  // Speak: a voice's level and the words heard so far, until the stop (⏎) gives the whole request.
  // What is said: to Marina in the reply (the hero), or the dinner invite in a new email (the Claude feature's compose).
  const saying = () =>
    location.hash.includes("compose") ? "Invite her to dinner on Saturday at the new place near the park, 8pm" : "Tell her the numbers work and ask for the final PDF today";
  demoAI.listen = (on) => {
    const said = saying();
    let n = 0;
    const tick = setInterval(() => {
      n++;
      on({ level: 0.25 + Math.abs(Math.sin(n / 2.3)) * 0.6 * Math.random() + 0.1 });
      if (n % 4 === 0) on({ text: said.split(" ").slice(0, n / 4).join(" ") });
    }, 66);
    return () => {
      clearInterval(tick);
      on({ done: said });
    };
  };
  // The reply's Claude bar writes for the account the mail came to.
  useAccountStore.getState().setAccounts(ACCOUNTS.map((a) => ({ id: a.id, email: a.email, displayName: "Alex", avatarUrl: null, isActive: true })));
  // The site's compose (c) opens as a new email to Clara, which Claude then writes.
  stashDraft({ accountId: "personal", to: ["clara.mendes@example.com"], subject: "Dinner on Saturday", html: "" });
  // Claude's draft: the new email to Clara, or the reply to Marina's proposal.
  demoAI.claude = (text) =>
    later(
      1800,
      text.toLowerCase().includes("clara")
        ? "<p>Hi Clara,</p><p>Are you free for dinner on Saturday? I'd love to try the new place near the park. How about 8pm? I can book a table for four.</p><p>Let me know!</p>"
        : "<p>Hi Marina,</p><p>The numbers work for me, and the earlier first milestone is even better. Please send the final PDF today and I will sign it this afternoon.</p><p>Thanks!</p>",
    );
}
