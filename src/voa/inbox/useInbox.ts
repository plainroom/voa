import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { isStarred, type DbThread, type ThreadKey } from "@/services/db/threads";
import { groupByTime } from "./groupByTime";
import { demoAI } from "../ai/demo";
import { inboxLabels, labelsOff, type Labels } from "../ai/tasks/labels";
import { SnoozeLabelUnavailable } from "@/services/snooze/snoozeManager";
import { formatRemindTime } from "../remind/remindTime";
import { keyId, useVoaStore, type InboxList } from "@/stores/list";
import { useToast, useToastStore } from "../ui/Toast";
import { inboxSource, type InboxAccount } from "./source";

/** The only Remind me failure the owner can act on: the label needs a connection the first time. */
const remindFailed = (err: unknown) => (err instanceof SnoozeLabelUnavailable ? "Couldn't snooze, try again online" : null);

/**
 * Done and Star throw only on a failure that will not go away by itself (a network one is queued
 * and retried, and succeeds here): the row comes back and the toast says so.
 */
const failedWith = (notice: string) => () => notice;

export const threadKey = (t: DbThread): ThreadKey => ({ accountId: t.account_id, threadId: t.id });

interface Read {
  accounts: InboxAccount[];
  threads: DbThread[];
  promotions: DbThread[];
  counts: Record<string, number>;
}
/**
 * Each list's last read, one for every screen that shows it: the reader and the list it returns to never hold two
 * copies, so a row the reader's read let go of is gone from the list in the same frame. A list opened again shows
 * it at once while it reads again, never an empty frame.
 */
const useReads = create<Record<string, Read>>(() => ({}));
/** For tests: each starts with no list read. */
export const forgetReads = () => useReads.setState({}, true);
/** Each list's newest read started: one that started before it and answers after it is dropped, never shown. */
const newest = new Map<string, number>();
let started = 0;
const NONE: never[] = [];
const NO_COUNTS: Record<string, number> = {};

/**
 * The list's data and its exits. `done`, `star` and `remind` take the row out at once, act through
 * emailActions, and leave an Undo on the toast (and on Z through `undoLast`).
 */
export function useInbox(list: InboxList) {
  const filter = useVoaStore((s) => s.filter);
  const pile = useVoaStore((s) => s.pile);
  const label = useVoaStore((s) => s.label);
  const { show } = useToast();
  const read = useReads((s) => s[`${list}:${filter}`]);
  const accounts = read?.accounts ?? NONE;
  const threads = read?.threads ?? NONE;
  const promotionThreads = read?.promotions ?? NONE;
  const sourceCounts = read?.counts ?? NO_COUNTS;
  const loading = !read;
  /** Each inbox conversation's labels (`<account>:<thread>`), and the ones the owner turned off. */
  const [labels, setLabels] = useState<{ found: Map<string, Labels>; off: Set<string> }>({ found: new Map(), off: new Set() });
  const hidden = useVoaStore((s) => s.hidden);
  /** How many exits have landed (written), for whoever reads something those writes change. */
  const [landed, setLanded] = useState(0);

  const reload = useCallback(async () => {
    const source = inboxSource();
    const key = `${list}:${filter}`;
    const read = ++started;
    newest.set(key, read);
    // Writes landed before this read are in it: those rows stop being hidden once it is shown.
    const landedBefore = [...useVoaStore.getState().landed];
    const [acc, rows, counts, promos] = await Promise.all([
      source.accounts(),
      source.threads(list, filter ? [filter] : undefined),
      source.counts(list),
      list === "INBOX" ? source.promotions() : Promise.resolve([]),
    ]);
    if (newest.get(key) !== read) return;
    useReads.setState({ [key]: { accounts: acc, threads: rows, promotions: promos, counts } });
    useVoaStore.getState().unhide(landedBefore);
    // A row stays hidden only while the store still has it (an action whose write has not landed yet).
    useVoaStore.getState().keepHidden(new Set([...rows, ...promos].map((t) => keyId(threadKey(t)))));
  }, [list, filter]);

  useEffect(() => {
    void reload();
    const onSync = () => void reload();
    window.addEventListener("voa-sync-done", onSync);
    return () => window.removeEventListener("voa-sync-done", onSync);
  }, [reload]);

  // Labels are read apart from the list: labeling lands after a sync (voa-labels), and Settings turns them on and off.
  useEffect(() => {
    if (list === "INBOX" && demoAI.labels) return setLabels({ found: demoAI.labels, off: new Set() });
    if (list !== "INBOX" || !("__TAURI_INTERNALS__" in window)) return;
    let live = true;
    const load = () =>
      void Promise.all([inboxLabels(), labelsOff()])
        .then(([found, off]) => live && setLabels({ found, off }))
        .catch((err: unknown) => console.warn("labels read failed", err));
    load();
    window.addEventListener("voa-labels", load);
    window.addEventListener("voa-sync-done", load);
    return () => {
      live = false;
      window.removeEventListener("voa-labels", load);
      window.removeEventListener("voa-sync-done", load);
    };
  }, [list]);

  /** The labels a row shows: its kind unless turned off, and respond first when it waits for the owner. */
  const labelsOf = useCallback(
    (t: DbThread): string[] => {
      const l = labels.found.get(keyId(threadKey(t)));
      if (!l) return [];
      return [...(l.respond && !labels.off.has("respond") ? ["respond"] : []), ...(l.kind && !labels.off.has(l.kind) ? [l.kind] : [])];
    },
    [labels],
  );

  const mail = useMemo(() => threads.filter((t) => !hidden.has(keyId(threadKey(t)))), [threads, hidden]);
  const promotions = useMemo(() => promotionThreads.filter((t) => !hidden.has(keyId(threadKey(t)))), [promotionThreads, hidden]);
  const pileRows = list === "INBOX" && pile === "promotions" ? promotions : mail;
  /** How many conversations of the pile on screen carry each label: what the filter offers. */
  const labelCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of pileRows) for (const l of labelsOf(t)) out.set(l, (out.get(l) ?? 0) + 1);
    return out;
  }, [pileRows, labelsOf]);
  const rows = useMemo(() => (label ? pileRows.filter((t) => labelsOf(t).includes(label)) : pileRows), [pileRows, label, labelsOf]);
  const groups = useMemo(() => groupByTime(rows, (t) => t.last_message_at ?? 0, new Date()), [rows]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { ...sourceCounts };
    for (const t of threads) {
      if (hidden.has(keyId(threadKey(t))) && out[t.account_id]) out[t.account_id]! -= 1;
    }
    return out;
  }, [sourceCounts, threads, hidden]);

  /**
   * Optimistic: takes the rows out and shows `message` with Undo at once, then runs `act` behind it.
   * A failed action puts the rows back and replaces the toast with `failed`'s words (none: silent).
   * Undo waits for `act` first, so the two calls never cross at the provider; after a failure it has nothing to undo.
   * Resolves when `act` has settled.
   */
  const optimistic = useCallback(
    async (keys: readonly ThreadKey[], message: string, act: () => Promise<void>, undo: () => Promise<void>, failed: (err: unknown) => string | null) => {
      const ids = keys.map(keyId);
      useVoaStore.getState().hide(ids);
      let error: unknown;
      const settled = act().then(
        () => true,
        (err: unknown) => {
          console.error("voa action failed:", err);
          error = err;
          return false;
        },
      );
      const before = useToastStore.getState().lastUndo;
      const undoIt = async () => {
        if (!(await settled)) return;
        await undo();
        useVoaStore.getState().unhide(ids);
        await reload();
        // The list may be another screen's by now (Undo from the reading screen): tell it to read again.
        window.dispatchEvent(new Event("voa-sync-done"));
      };
      show(message, undoIt);
      if (await settled) {
        // Landed: every list reads again and shows the rows where they now belong (gone, or in Trash or Starred). Unhiding
        // here instead would show the row again in a list whose screen did not run the exit (the reader closed after it).
        useVoaStore.getState().land(ids);
        await reload();
        window.dispatchEvent(new Event("voa-sync-done"));
        setLanded((n) => n + 1);
        return;
      }
      useVoaStore.getState().unhide(ids);
      await reload();
      window.dispatchEvent(new Event("voa-sync-done"));
      // The failed action's toast goes, and Cmd+Z undoes what it undid before.
      if (useToastStore.getState().lastUndo === undoIt) useToastStore.setState({ current: null, lastUndo: before });
      const notice = failed(error);
      if (notice) show(notice);
    },
    [show, reload],
  );

  const exit = useCallback(
    (k: ThreadKey, message: string, act: () => Promise<void>, undo: () => Promise<void>, failed?: (err: unknown) => string | null) =>
      optimistic([k], message, act, undo, failed ?? (() => null)),
    [optimistic],
  );

  const done = useCallback(
    (k: ThreadKey) => {
      const source = inboxSource();
      return exit(
        k,
        "Done",
        () => source.archive(k),
        () => source.unarchive(k),
        failedWith("Couldn't archive"),
      );
    },
    [exit],
  );

  /** Stars an unstarred conversation (and takes it out of the inbox), unstars a starred one: as it is stored, wherever it was opened. */
  const star = useCallback(
    async (k: ThreadKey) => {
      const source = inboxSource();
      if (isStarred(await source.thread(k))) {
        return exit(
          k,
          "Unstarred",
          () => source.star(k, false),
          () => source.star(k, true),
          failedWith("Couldn't unstar"),
        );
      }
      return exit(
        k,
        "Starred",
        async () => {
          await source.star(k, true);
          try {
            await source.archive(k);
          } catch (err) {
            // Starred but still in the inbox is neither: it goes back as it was.
            await source.star(k, false).catch(() => {});
            throw err;
          }
        },
        async () => {
          await source.unarchive(k);
          await source.star(k, false);
        },
        failedWith("Couldn't star"),
      );
    },
    [exit],
  );

  /**
   * Remind me until `until` (unix seconds). From the inbox the row leaves and Undo brings it back;
   * in Snoozed the row stays with its new time and Undo puts the old one back.
   */
  const remind = useCallback(
    async (k: ThreadKey, until: number) => {
      const source = inboxSource();
      const message = `Snoozed until ${formatRemindTime(new Date(until * 1000), new Date())}`;
      const before = threads.find((t) => keyId(threadKey(t)) === keyId(k))?.snooze_until;
      if (list !== "SNOOZED" || !before) {
        return exit(
          k,
          message,
          () => source.remind(k, until),
          () => source.unremind(k),
          remindFailed,
        );
      }
      // Optimistic too: the toast now, the row's new time once the write lands.
      const settled = source.remind(k, until).then(
        () => true,
        (err: unknown) => {
          console.error("voa action failed:", err);
          const notice = remindFailed(err);
          if (notice) show(notice);
          return false;
        },
      );
      show(message, async () => {
        if (!(await settled)) return;
        await source.remind(k, before);
        await reload();
      });
      if (await settled) await reload();
    },
    [exit, list, threads, reload, show],
  );

  const archiveMany = useCallback(
    async (keys: readonly ThreadKey[]) => {
      if (keys.length === 0) return;
      const source = inboxSource();
      await optimistic(
        keys,
        keys.length === 1 ? "Done" : `Done ${keys.length}`,
        () => source.archiveMany(keys),
        async () => {
          for (const k of keys) await source.unarchive(k);
        },
        failedWith("Couldn't archive"),
      );
    },
    [optimistic],
  );

  const remove = useCallback(
    async (keys: readonly ThreadKey[]) => {
      if (keys.length === 0) return;
      const source = inboxSource();
      const restore = list === "INBOX" ? "INBOX" : list === "SPAM" ? "SPAM" : null;
      await optimistic(
        keys,
        keys.length === 1 ? "Deleted" : `Deleted ${keys.length}`,
        () => source.trashMany(keys),
        async () => {
          for (const k of keys) await source.untrash(k, restore);
        },
        failedWith("Couldn't delete"),
      );
    },
    [optimistic, list],
  );

  /** Out of Trash or Done, back to the inbox. Undo puts it back where it was. */
  const restore = useCallback(
    (k: ThreadKey) => {
      const source = inboxSource();
      const fromTrash = list === "TRASH";
      return exit(
        k,
        "Moved to Inbox",
        () => (fromTrash ? source.untrash(k, "INBOX") : source.unarchive(k)),
        () => (fromTrash ? source.trash(k) : source.archive(k)),
        failedWith("Couldn't move to Inbox"),
      );
    },
    [exit, list],
  );

  const undoLast = useCallback(() => useToastStore.getState().undoLast(), []);

  const spam = useCallback(
    (k: ThreadKey) => {
      const source = inboxSource();
      return exit(
        k,
        "Marked as spam",
        () => source.spam(k),
        () => source.unspam(k),
        failedWith("Couldn't mark as spam"),
      );
    },
    [exit],
  );

  /** Archive after a successful unsubscribe. Undo brings the conversation back; it does not resubscribe. */
  const unsubscribed = useCallback(
    (k: ThreadKey) => {
      const source = inboxSource();
      return exit(
        k,
        "Unsubscribed",
        () => source.archive(k),
        () => source.unarchive(k),
        failedWith("Couldn't archive"),
      );
    },
    [exit],
  );

  const block = useCallback(
    (k: ThreadKey) => {
      const source = inboxSource();
      let touched: ThreadKey[] = [];
      let address = "";
      return exit(
        k,
        "Blocked",
        async () => {
          const result = await source.block(k);
          touched = result.threads;
          address = result.address;
          window.dispatchEvent(new Event("voa-sync-done"));
        },
        async () => {
          await source.unblock(k.accountId, address);
          for (const t of touched) await source.unarchive(t);
        },
        failedWith("Couldn't block"),
      );
    },
    [exit],
  );

  const next = useCallback(
    (k: ThreadKey): ThreadKey | null => {
      const i = rows.findIndex((t) => keyId(threadKey(t)) === keyId(k));
      const after = i === -1 ? undefined : rows[i + 1];
      return after ? threadKey(after) : null;
    },
    [rows],
  );

  return {
    loading,
    accounts,
    counts,
    rows,
    promotions,
    labelsOf,
    labelCounts,
    groups,
    done,
    restore,
    archiveMany,
    star,
    remind,
    remove,
    spam,
    unsubscribed,
    block,
    undoLast,
    next,
    reload,
    landed,
  };
}
