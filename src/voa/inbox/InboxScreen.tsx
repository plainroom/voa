import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Clock, Ellipsis, Inbox, ListFilter, OctagonAlert, PenLine, Search, Settings, Star, Trash2 } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useSignedOut } from "@/services/oauth/signedOut";
import { useReconnect } from "../accounts/useReconnect";
import { isStarred, type ThreadKey } from "@/services/db/threads";
import { formatRowDate } from "./formatRowDate";
import { formatRemindTime } from "../remind/remindTime";
import { RemindPicker } from "../remind/RemindPicker";
import { LIST_PATH, sameKey, useVoaStore, type InboxList } from "@/stores/list";
import { Button, Empty, GroupHeader, IconButton, LabelTag, Picker, PickerLayer, Row, RowAction, TopBar, type TopBarTab } from "../ui";
import { InboxZero } from "../zero/InboxZero";
import { zeroState } from "../zero/zeroState";
import { inboxSource } from "./source";
import { rangePicked, stillShown, togglePicked } from "./selection";
import { loginCode, plainHead } from "./loginCode";
import { threadKey, useInbox } from "./useInbox";
import { useInboxKeys } from "./useInboxKeys";

const LIST_TITLE: Record<InboxList, string> = {
  INBOX: "Inbox",
  STARRED: "Starred",
  SNOOZED: "Snoozed",
  SPAM: "Spam",
  TRASH: "Trash",
  DONE: "Done",
};

/** The lists the … menu goes to, each with the icon it had in the bar (Done: the row's Done) and its keys. */
const listIcon = (Icon: typeof Star) => <Icon size={15} strokeWidth={1.75} className="mr-2.5 text-ink-3" />;
const LISTS: { id: InboxList; label: string; lead: ReactNode; hint?: string }[] = [
  { id: "INBOX", label: "Inbox", lead: listIcon(Inbox), hint: "G I" },
  { id: "STARRED", label: "Starred", lead: listIcon(Star), hint: "G S" },
  { id: "DONE", label: "Done", lead: listIcon(Check) },
  { id: "SPAM", label: "Spam", lead: listIcon(OctagonAlert), hint: "G P" },
  { id: "TRASH", label: "Trash", lead: listIcon(Trash2), hint: "G T" },
];

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** The unified list: every account in one place, one line per conversation. */
export function InboxScreen({ list }: { list: InboxList }) {
  const navigate = useNavigate();
  const { filter, selected, setFilter, select, setList, pile, setPile, label, setLabel } = useVoaStore();
  const [picked, setPicked] = useState<readonly ThreadKey[]>([]);
  /** The row a Shift+click extends from. */
  const anchor = useRef(0);
  const inbox = useInbox(list);
  const [now] = useState(() => new Date());
  /** The row Remind me is open for, and the time it opened (the presets count from it). */
  /** The label filter is open (the filter icon). */
  const [filtering, setFiltering] = useState(false);
  /** The lists menu (…): every list but the inbox's own icons (filter, search, compose, settings). */
  const [going, setGoing] = useState(false);
  const [reminding, setReminding] = useState<{
    key: ThreadKey;
    at: Date;
  } | null>(null);

  useEffect(() => {
    setList(list);
    if (list !== "INBOX") setPile("mail");
  }, [list, setList, setPile]);

  const rows = inbox.rows;
  const promotionRows = list === "INBOX" ? inbox.promotions : [];
  const groups = inbox.groups;
  const keys = useMemo(() => rows.map(threadKey), [rows]);
  const colorOf = useMemo(() => Object.fromEntries(inbox.accounts.map((a) => [a.id, a.color])), [inbox.accounts]);

  // Keep a row selected: the first one, or the neighbour of a row that left.
  const lastIndex = useRef(0);
  useEffect(() => {
    const i = keys.findIndex((k) => sameKey(k, selected));
    if (i !== -1) {
      lastIndex.current = i;
      return;
    }
    const fallback = keys[Math.min(lastIndex.current, keys.length - 1)];
    if (fallback) select(fallback);
  }, [keys, selected, select]);

  useEffect(() => {
    document.querySelector('[role="row"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // A selection belongs to the rows on screen: another list, account tab or pile starts with none.
  useEffect(() => setPicked([]), [list, filter, pile, label]);

  // Blank space clears. A row stops its own click, and its buttons already do.
  const clearPicked = () => setPicked((current) => (current.length === 0 ? current : []));

  const pick = (index: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const key = keys[index];
    if (!key) return;
    if (e.shiftKey) {
      const cursor = keys.findIndex((row) => sameKey(row, selected));
      const from = picked.length > 0 ? anchor.current : cursor === -1 ? index : cursor;
      setPicked(rangePicked(keys, from, index));
      return;
    }
    anchor.current = index;
    const removing = picked.some((row) => sameKey(row, key));
    setPicked((current) => togglePicked(current, key));
    if (!removing) select(key);
  };
  const open = (k: ThreadKey) => {
    setPicked([]);
    select(k);
    void navigate({
      to: "/t/$accountId/$threadId",
      params: { accountId: k.accountId, threadId: k.threadId },
    });
  };
  const done = (k: ThreadKey) => {
    if (picked.length > 0) {
      if (list !== "INBOX") return;
      const targets = stillShown(picked, keys);
      setPicked([]);
      if (targets.length > 0) void inbox.archiveMany(targets);
      return;
    }
    if (list === "INBOX") void inbox.done(k);
    if (list === "TRASH" || list === "DONE") void inbox.restore(k);
  };
  const canStar = list !== "SNOOZED" && list !== "TRASH";
  const star = (k: ThreadKey) => canStar && void inbox.star(k);
  const canRemind = list !== "STARRED" && list !== "SPAM" && list !== "TRASH";
  const remind = (k: ThreadKey) => canRemind && setReminding({ key: k, at: new Date() });
  const compose = () => void navigate({ to: "/compose" });
  const search = () => void navigate({ to: "/search", search: { q: "" } });
  const settings = () => void navigate({ to: "/settings" });

  useInboxKeys({
    rows: keys,
    selected,
    accountIds: inbox.accounts.map((a) => a.id),
    select: (k) => {
      const i = keys.findIndex((row) => sameKey(row, k));
      if (i !== -1) anchor.current = i;
      setPicked([]);
      select(k);
    },
    selectAll: () => {
      const i = keys.findIndex((row) => sameKey(row, selected));
      anchor.current = i === -1 ? 0 : i;
      setPicked(keys);
    },
    clearSelection: () => {
      if (picked.length === 0) return false;
      setPicked([]);
      return true;
    },
    remove: () => {
      if (list === "TRASH") return;
      const targets = picked.length > 0 ? stillShown(picked, keys) : list === "SPAM" && selected ? [selected] : [];
      if (targets.length === 0) return;
      setPicked([]);
      void inbox.remove(targets);
    },
    open,
    done,
    star,
    remind,
    undo: () => void inbox.undoLast(),
    compose,
    search,
    settings,
    setFilter,
    goList: (l) => {
      // The Inbox is all of it: Esc or g then i from an account, Promotions or a label comes back to every account's mail.
      if (l === "INBOX") {
        setFilter(null);
        setPile("mail");
        setLabel(null);
      }
      void navigate({ to: LIST_PATH[l] });
    },
  });

  const total = Object.values(inbox.counts).reduce((a, b) => a + b, 0);

  // An empty inbox is the photo, or a quiet line for one clear account.
  // Sync never writes on it. Only Offline and an account its provider signed out are a note; the second one is its Reconnect.
  const online = useUIStore((s) => s.isOnline);
  const signedOut = useSignedOut((s) => s.ids);
  const { busy, reconnect } = useReconnect();
  const out = inbox.accounts.find((a) => signedOut.has(a.id));

  const zero =
    list === "INBOX" && pile === "mail" && label === null && !inbox.loading && inbox.accounts.length > 0 && rows.length === 0
      ? zeroState({ counts: inbox.counts, filter })
      : null;
  const zeroAccount = inbox.accounts.find((a) => a.id === filter)?.name ?? "";
  const [starred, setStarred] = useState(0);
  useEffect(() => {
    if (zero !== "allClear") return;
    let current = true;
    void inboxSource()
      .counts("STARRED")
      .then((c) => current && setStarred(Object.values(c).reduce((a, b) => a + b, 0)))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [zero, inbox.landed]);
  const tabs: TopBarTab[] = [
    // From Starred / Snoozed / Spam, Inbox is a real tab so leaving does not depend on g then i.
    ...(list !== "INBOX" ? [{ id: "__inbox", label: "Inbox", count: 0, active: false }] : []),
    {
      id: "all",
      label: LIST_TITLE[list],
      count: total,
      active: filter === null && pile === "mail",
    },
    ...(inbox.accounts.length > 1
      ? inbox.accounts.map((a) => ({
          id: a.id,
          label: a.name,
          count: inbox.counts[a.id] ?? 0,
          dotColor: a.color,
          active: filter === a.id && pile === "mail",
        }))
      : []),
    ...(promotionRows.length > 0 ? [{ id: "__promotions", label: "Promotions", count: promotionRows.length, active: pile === "promotions" }] : []),
  ];

  return (
    <div className="relative flex h-screen flex-col bg-canvas text-ink">
      <div className={`relative z-10 ${zero === "allClear" ? "on-photo" : ""}`}>
        <TopBar
          tabs={tabs}
          onRestClick={clearPicked}
          note={
            out ? (
              <button type="button" disabled={busy === out.id} className="text-warning hover:text-ink" onClick={() => void reconnect(out.id)}>
                {busy === out.id ? "Waiting for the sign-in…" : `${out.name} is signed out · Reconnect`}
              </button>
            ) : online ? undefined : (
              "Offline"
            )
          }
          onTab={(id) => {
            if (id === "__promotions") {
              setPile("promotions");
              setFilter(null);
              return;
            }
            setPile("mail");
            if (id === "__inbox") {
              void navigate({ to: LIST_PATH.INBOX });
              return;
            }
            setFilter(id === "all" ? null : id);
          }}
          right={
            <>
              <IconButton label="Lists" onClick={() => setGoing(true)}>
                <Ellipsis size={15} strokeWidth={1.75} />
              </IconButton>
              {list === "INBOX" && label && (
                <button type="button" aria-label={`Show every label (now ${label})`} onClick={() => setLabel(null)} className="inline-flex items-center">
                  <LabelTag name={label} />
                </button>
              )}
              {list === "INBOX" && inbox.labelCounts.size > 0 && (
                <IconButton label="Filter by label" onClick={() => setFiltering(true)}>
                  <ListFilter size={15} strokeWidth={1.75} />
                </IconButton>
              )}
              <IconButton label="Search" keys="⌘F" onClick={search}>
                <Search size={15} strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Compose" keys="C" onClick={compose}>
                <PenLine size={15} strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Settings" keys="," onClick={settings}>
                <Settings size={15} strokeWidth={1.75} />
              </IconButton>
            </>
          }
        />
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto pb-16" onClick={clearPicked}>
        {!inbox.loading && inbox.accounts.length === 0 ? (
          <Empty title="Connect an account" line="voa puts every inbox in one list.">
            <Button variant="primary" onClick={() => window.dispatchEvent(new Event("voa-add-account"))}>
              Add account
            </Button>
          </Empty>
        ) : zero ? (
          <InboxZero state={zero} accountName={zeroAccount} starred={starred} now={now} onStarred={() => void navigate({ to: LIST_PATH.STARRED })} />
        ) : !inbox.loading && rows.length === 0 ? (
          <Empty
            title={
              pile === "promotions"
                ? "No promotions."
                : label
                  ? `Nothing labeled ${label}.`
                  : list === "INBOX"
                    ? "All clear."
                    : list === "SPAM"
                      ? "No spam."
                      : list === "TRASH"
                        ? "Trash is empty."
                        : `Nothing ${LIST_TITLE[list].toLowerCase()}`
            }
          />
        ) : (
          groups.map((g) => (
            <section key={g.label}>
              <GroupHeader label={g.label} />
              {g.items.map((t) => {
                const k = threadKey(t);
                return (
                  <Row
                    key={`${t.account_id}:${t.id}`}
                    dotColor={colorOf[t.account_id] ?? null}
                    from={t.from_name || t.from_address || "Unknown sender"}
                    subject={t.subject || "(no subject)"}
                    preview={t.snippet ?? ""}
                    code={loginCode(`${t.subject ?? ""}\n${t.snippet ?? ""}\n${plainHead(t.body_head)}`)}
                    date={
                      list === "SNOOZED" && t.snooze_until ? formatRemindTime(new Date(t.snooze_until * 1000), now) : formatRowDate(t.last_message_at ?? 0, now)
                    }
                    unread={t.is_read === 0}
                    attachment={t.has_attachments === 1}
                    labels={list === "INBOX" ? inbox.labelsOf(t) : undefined}
                    selected={picked.length > 0 ? picked.some((p) => sameKey(p, k)) : sameKey(k, selected)}
                    onOpen={() => open(k)}
                    onPick={(e) =>
                      pick(
                        keys.findIndex((row) => sameKey(row, k)),
                        e,
                      )
                    }
                    actions={
                      <>
                        {list === "SPAM" && (
                          <RowAction label="Delete" keys="⌫" onClick={() => void inbox.remove([k])}>
                            <Trash2 size={14} strokeWidth={1.75} />
                          </RowAction>
                        )}
                        {(list === "TRASH" || list === "DONE") && (
                          <RowAction label="Move to Inbox" keys="E" onClick={() => done(k)}>
                            <Inbox size={14} strokeWidth={1.75} />
                          </RowAction>
                        )}
                        {list === "INBOX" && (
                          <RowAction label="Done" keys="E" onClick={() => done(k)}>
                            <Check size={14} strokeWidth={1.75} />
                          </RowAction>
                        )}
                        {canRemind && (
                          <RowAction label="Remind me" keys="H" onClick={() => remind(k)}>
                            <Clock size={14} strokeWidth={1.75} />
                          </RowAction>
                        )}
                        {canStar && (
                          <RowAction label={isStarred(t) ? "Unstar" : "Star"} keys="S" onClick={() => star(k)}>
                            <Star size={14} strokeWidth={1.75} fill={isStarred(t) ? "currentColor" : "none"} />
                          </RowAction>
                        )}
                      </>
                    }
                  />
                );
              })}
            </section>
          ))
        )}
      </main>

      {going && (
        <PickerLayer onClose={() => setGoing(false)}>
          <Picker
            items={LISTS.filter((l) => l.id !== list)}
            onPick={(choice) => {
              setGoing(false);
              if ("id" in choice) void navigate({ to: LIST_PATH[choice.id as InboxList] });
            }}
            onClose={() => setGoing(false)}
          />
        </PickerLayer>
      )}
      {filtering && (
        <PickerLayer onClose={() => setFiltering(false)}>
          <Picker
            items={[
              { id: "", label: "Every conversation" },
              ...[...inbox.labelCounts]
                .sort(([a, x], [b, y]) => (a === "respond" ? -1 : b === "respond" ? 1 : y - x))
                .map(([name, count]) => ({ id: name, label: "", lead: <LabelTag name={name} />, hint: String(count) })),
            ]}
            onPick={(choice) => {
              setFiltering(false);
              if ("id" in choice) setLabel(choice.id || null);
            }}
            onClose={() => setFiltering(false)}
          />
        </PickerLayer>
      )}
      {reminding && (
        <RemindPicker
          opened={reminding.at}
          onClose={() => setReminding(null)}
          onPick={(until) => {
            setReminding(null);
            void inbox.remind(reminding.key, unix(until));
          }}
        />
      )}
    </div>
  );
}
