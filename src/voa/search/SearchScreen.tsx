import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { formatRowDate } from "../inbox/formatRowDate";
import { groupByTime } from "../inbox/groupByTime";
import { loginCode } from "../inbox/loginCode";
import { inboxSource } from "../inbox/source";
import { useVoaStore } from "@/stores/list";
import { Empty, GroupHeader, IconButton, Row, TextField } from "../ui";
import type { SearchHit } from "./searchThreads";

/** Disk answers in milliseconds, so it searches as the owner types. */
const DEBOUNCE_MS = 150;
/** The mailboxes are asked only once typing pauses (or on Enter): each ask spends their quota. */
const REMOTE_PAUSE_MS = 500;

const keyOf = (h: SearchHit) => `${h.accountId}:${h.threadId}`;

/**
 * Search over every account at once: the same rows, grouped by time. What is on disk shows at once; the mailboxes
 * are asked in the background and what they add joins the list, the selected row kept. Enter opens, Esc goes back.
 */
export function SearchScreen({ q }: { q: string }) {
  const navigate = useNavigate();
  const select = useVoaStore((s) => s.select);
  const [text, setText] = useState(q);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  /** The text `hits` answer. Until the new text's own answer lands, Enter opens none of the old rows. */
  const [hitsFor, setHitsFor] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Record<string, string | null>>({});
  /** The selected row by its key, so rows a remote answer adds above it do not move the selection. */
  const [selected, setSelected] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [now] = useState(() => new Date());
  const field = useRef<HTMLInputElement>(null);
  /** Asks the mailboxes for the current text now, instead of after the pause. */
  const askNow = useRef<() => void>(() => {});

  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener("voa-focus-search", focus);
    return () => window.removeEventListener("voa-focus-search", focus);
  }, []);
  useEffect(() => {
    void inboxSource()
      .accounts()
      .then((list) => setAccounts(Object.fromEntries(list.map((a) => [a.id, a.color]))))
      .catch(() => {});
  }, []);

  // The query lives in the address (a reload keeps it); typing replaces it, never stacks entries.
  // A newer text ends this one: its answers, local or remote, are dropped and its remote ask aborted.
  useEffect(() => {
    const trimmed = text.trim();
    let current = true;
    const controller = new AbortController();
    const searchDisk = (keepSelection: boolean) =>
      inboxSource()
        .search(trimmed)
        .then((found) => {
          if (!current) return;
          setHits(found);
          setHitsFor(trimmed);
          setSelected((prev) => (keepSelection && prev && found.some((h) => keyOf(h) === prev) ? prev : found[0] ? keyOf(found[0]) : null));
        })
        .catch((err) => {
          console.error("voa search failed:", err);
          if (current && !keepSelection) setHits([]);
        });
    let asked = false;
    const askMailboxes = () => {
      if (asked || !trimmed || !current) return;
      asked = true;
      setSearching(true);
      void inboxSource()
        .searchRemote(trimmed, { signal: controller.signal, onStored: () => void searchDisk(true) })
        .catch((err) => console.warn("voa remote search failed:", err))
        .finally(() => current && setSearching(false));
    };
    askNow.current = askMailboxes;
    const local = setTimeout(() => {
      void navigate({ to: "/search", search: { q: text }, replace: true });
      if (!trimmed) {
        setHitsFor(trimmed);
        return setHits([]);
      }
      void searchDisk(false);
    }, DEBOUNCE_MS);
    const remote = setTimeout(askMailboxes, REMOTE_PAUSE_MS);
    return () => {
      current = false;
      controller.abort();
      clearTimeout(local);
      clearTimeout(remote);
      setSearching(false);
    };
  }, [text, navigate]);

  const rows = useMemo(() => hits ?? [], [hits]);
  const index = Math.max(0, rows.findIndex((h) => keyOf(h) === selected));
  const groups = useMemo(() => groupByTime(rows, (h) => h.date, now), [rows, now]);
  const back = () => void navigate({ to: "/" });
  const open = (h: SearchHit) => {
    select({ accountId: h.accountId, threadId: h.threadId });
    void navigate({ to: "/t/$accountId/$threadId", params: { accountId: h.accountId, threadId: h.threadId } });
  };

  useEffect(() => {
    document.querySelector('[role="row"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const move = (step: number) => {
    const next = rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
    if (next) setSelected(keyOf(next));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      back();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hitsFor !== text.trim()) return;
      if (rows[index]) open(rows[index]!);
      else askNow.current();
    }
  };

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink" onKeyDown={onKeyDown}>
      <header data-tauri-drag-region className="shrink-0 px-8 pt-9 pb-1 select-none">
        <div data-tauri-drag-region className="flex h-9 items-center gap-3">
          <IconButton label="Back" keys="Esc" onClick={back}>
            <ArrowLeft size={15} strokeWidth={1.75} />
          </IconButton>
          <div className="flex-1">
            <TextField
              ref={field}
              aria-label="Search"
              data-search-field
              placeholder="Search every account"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {searching ? (
            <span role="status" className="shrink-0 text-meta text-ink-3">
              Searching your accounts…
            </span>
          ) : null}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-16">
        {hits !== null && rows.length === 0 && !searching ? (
          <Empty title={text.trim() ? "No matches" : "Search"} line={text.trim() ? undefined : "from: to: subject: is:unread has:attachment"} />
        ) : (
          groups.map((g) => (
            <section key={g.label}>
              <GroupHeader label={g.label} />
              {g.items.map((h) => (
                <Row
                  key={`${h.accountId}:${h.threadId}`}
                  dotColor={accounts[h.accountId] ?? null}
                  from={h.from}
                  subject={h.subject}
                  preview={h.snippet}
                  code={loginCode(`${h.subject}\n${h.snippet}`)}
                  date={formatRowDate(h.date, now)}
                  unread={false}
                  selected={rows[index] === h}
                  onOpen={() => open(h)}
                />
              ))}
            </section>
          ))
        )}
      </main>
    </div>
  );
}
