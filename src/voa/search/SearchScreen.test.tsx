import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tanstack/react-router")>()), useNavigate: () => navigate }));

import { getDb } from "@/services/db/connection";
import { inboxSource, realSource, setDemoSource, type InboxSource } from "../inbox/source";
import { asDb, createInboxDb } from "../inbox/inboxDb.test-helper";
import { SearchScreen } from "./SearchScreen";
import { searchThreads, type SearchHit } from "./searchThreads";

let sqlite: DatabaseSync;

/** The inbox test tables plus the real messages_fts (trigram, as migration 2 makes it). */
async function createSearchDb() {
  const db = await createInboxDb();
  db.exec(`
    DROP TABLE messages;
    CREATE TABLE messages (id TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL, subject TEXT,
      from_name TEXT, from_address TEXT, to_addresses TEXT, snippet TEXT, body_text TEXT, is_read INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0, date INTEGER NOT NULL);
    CREATE VIRTUAL TABLE messages_fts USING fts5(subject, from_name, from_address, body_text, snippet,
      content='messages', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
      VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
    END;
  `);
  return db;
}

const message = (account: string, id: string, thread: string, subject: string, date: number) =>
  sqlite
    .prepare("INSERT INTO messages (id, account_id, thread_id, subject, from_name, snippet, date) VALUES (?, ?, ?, ?, 'Sender', ?, ?)")
    .run(id, account, thread, subject, `about ${subject}`, date);

beforeEach(async () => {
  vi.clearAllMocks();
  sqlite = await createSearchDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
  message("a", "m1", "t1", "Invoice from the landlord", 1_000);
  message("b", "m2", "t2", "Invoice for the project", 3_000);
  message("b", "m3", "t2", "Re: Invoice for the project", 4_000);
  message("a", "m4", "t3", "Dinner on Saturday", 2_000);
  Element.prototype.scrollIntoView = vi.fn();
  setDemoSource(realSource);
});

describe("search", () => {
  it("search returns matches from both accounts", async () => {
    const hits = await searchThreads("invoice");
    // one hit per conversation, newest first, from both accounts
    expect(hits.map((h) => [h.accountId, h.threadId, h.date])).toEqual([
      ["b", "t2", 4_000],
      ["a", "t1", 1_000],
    ]);
  });

  it("text FTS5 cannot parse still searches, as a phrase", async () => {
    message("a", "m5", "t4", 'He said "no-go" twice', 5_000);
    expect((await searchThreads('"no-go')).map((h) => h.threadId)).toEqual(["t4"]);
  });

  it("a recipient that is not in the full-text index still matches", async () => {
    sqlite
      .prepare("INSERT INTO messages (id, account_id, thread_id, subject, from_name, from_address, to_addresses, snippet, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("m9", "a", "t9", "Listas pra revisao", "Me", "me@example.com", "Hiago Mendonca <hiago@example.com>", "notes", 9_000);
    expect((await searchThreads("hiago")).map((h) => h.threadId)).toEqual(["t9"]);
  });

  it("operators work across accounts", async () => {
    expect((await searchThreads("subject:dinner")).map((h) => h.threadId)).toEqual(["t3"]);
  });

  it("shows the results grouped, Enter opens the selected thread and Esc goes back", async () => {
    render(<SearchScreen q="invoice" />);
    await screen.findByText("Re: Invoice for the project");
    expect(screen.getByText("Invoice from the landlord")).toBeTruthy();
    const field = screen.getByLabelText("Search");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t1" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("Cmd+F, from the search screen, puts the cursor back in the field", async () => {
    render(<SearchScreen q="" />);
    const field = screen.getByLabelText("Search");
    field.blur();
    expect(document.activeElement).not.toBe(field);
    window.dispatchEvent(new Event("voa-focus-search"));
    expect(document.activeElement).toBe(field);
  });

  it("typing searches again and says when nothing matches", async () => {
    render(<SearchScreen q="" />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zzzzzz" } });
    await screen.findByText("No matches");
    expect(inboxSource()).toBe(realSource);
  });
});

describe("search asks the mailboxes in the background", () => {
  const hit = (threadId: string, subject: string, date: number): SearchHit => ({ accountId: "a", threadId, from: "Sender", subject, snippet: "", date });
  /** What each query finds on disk; a remote answer adds to it. */
  let disk: Record<string, SearchHit[]>;
  let asks: { query: string; signal: AbortSignal; onStored: () => void; resolve: () => void }[];

  beforeEach(() => {
    disk = { invoice: [hit("t1", "Invoice A", 4_000), hit("t2", "Invoice B", 1_000)], other: [hit("t5", "Other thing", 2_000)] };
    asks = [];
    const source: InboxSource = {
      ...realSource,
      accounts: async () => [],
      search: async (query) => disk[query] ?? [],
      searchRemote: (query, { signal, onStored }) =>
        new Promise<void>((resolve) => {
          asks.push({ query, signal, onStored, resolve });
        }),
    };
    setDemoSource(source);
  });

  it("shows what is on disk before the mailboxes answer, then adds their hits, keeping the selected row", async () => {
    render(<SearchScreen q="invoice" />);
    await screen.findByText("Invoice A");
    expect(asks).toEqual([]);
    expect(screen.queryByText("Searching your accounts…")).toBeNull();

    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "ArrowDown" });
    await screen.findByText("Searching your accounts…");
    expect(asks.map((a) => a.query)).toEqual(["invoice"]);

    disk.invoice = [hit("t9", "Invoice newer", 9_000), ...disk.invoice!];
    await act(async () => {
      asks[0]!.onStored();
      asks[0]!.resolve();
    });
    await screen.findByText("Invoice newer");
    await waitFor(() => expect(screen.queryByText("Searching your accounts…")).toBeNull());
    const selected = document.querySelector('[role="row"][aria-selected="true"]');
    expect(selected?.textContent).toContain("Invoice B");
  });

  it("ignores what the mailboxes answer for a query the owner already changed, and aborts it", async () => {
    render(<SearchScreen q="invoice" />);
    await waitFor(() => expect(asks).toHaveLength(1), { timeout: 2_000 });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "other" } });
    await screen.findByText("Other thing");
    expect(asks[0]!.signal.aborted).toBe(true);

    disk.invoice = [hit("t9", "Invoice newer", 9_000)];
    await act(async () => {
      asks[0]!.onStored();
      asks[0]!.resolve();
    });
    expect(screen.queryByText("Invoice newer")).toBeNull();
    expect(screen.getByText("Other thing")).toBeTruthy();
  });

  it("Enter right after the text changed never opens a row of the previous text", async () => {
    render(<SearchScreen q="invoice" />);
    await screen.findByText("Invoice A");
    const field = screen.getByLabelText("Search");
    fireEvent.change(field, { target: { value: "other" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: "/t/$accountId/$threadId" }));
    await screen.findByText("Other thing");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$accountId/$threadId", params: { accountId: "a", threadId: "t5" } });
  });

  it("Enter with nothing on disk asks the mailboxes at once", async () => {
    render(<SearchScreen q="" />);
    const field = screen.getByLabelText("Search");
    fireEvent.change(field, { target: { value: "nothing" } });
    await screen.findByText("No matches");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(asks.map((a) => a.query)).toEqual(["nothing"]);
    await screen.findByText("Searching your accounts…");
    expect(screen.queryByText("No matches")).toBeNull();
  });
});
