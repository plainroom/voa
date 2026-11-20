import { create } from "zustand";
import type { ThreadKey } from "@/services/db/threads";

export type InboxList = "INBOX" | "STARRED" | "SNOOZED" | "SPAM" | "TRASH" | "DONE";

/** Each list's route. Quiet: Spam is only reachable by g then p, not a main tab. */
export const LIST_PATH = {
  INBOX: "/",
  STARRED: "/starred",
  SNOOZED: "/snoozed",
  SPAM: "/spam",
  TRASH: "/trash",
  DONE: "/done",
} as const;

interface VoaState {
  /** Account id the list is filtered to; null is every account (the default and the point). */
  filter: string | null;
  selected: ThreadKey | null;
  list: InboxList;
  /** Promotions are Gmail's category, listed apart from the inbox. Mail is the list you clear. */
  pile: "mail" | "promotions";
  /** The list shows only conversations with this label (the filter icon), or every one. */
  label: string | null;
  setFilter: (filter: string | null) => void;
  select: (key: ThreadKey | null) => void;
  setList: (list: InboxList) => void;
  setPile: (pile: "mail" | "promotions") => void;
  setLabel: (label: string | null) => void;
  /** Rows an exit took out before its write landed (`keyId`s). Shared, so the reader and the list agree. */
  hidden: ReadonlySet<string>;
  /** Hidden rows whose write has landed: the next read of a list has them where they belong, and they stop being hidden. */
  landed: ReadonlySet<string>;
  hide: (ids: readonly string[]) => void;
  unhide: (ids: readonly string[]) => void;
  land: (ids: readonly string[]) => void;
  /** Keeps hidden only the rows a list still has: the others' writes have landed. */
  keepHidden: (present: ReadonlySet<string>) => void;
}

export const useVoaStore = create<VoaState>((set) => ({
  filter: null,
  selected: null,
  list: "INBOX",
  pile: "mail",
  label: null,
  setFilter: (filter) => set({ filter }),
  select: (selected) => set({ selected }),
  setList: (list) => set((s) => (s.list === list ? s : { list, selected: null })),
  setPile: (pile) => set({ pile }),
  setLabel: (label) => set({ label }),
  hidden: new Set(),
  landed: new Set(),
  hide: (ids) => set((s) => ({ hidden: new Set([...s.hidden, ...ids]) })),
  unhide: (ids) =>
    set((s) => ({
      hidden: new Set([...s.hidden].filter((id) => !ids.includes(id))),
      landed: new Set([...s.landed].filter((id) => !ids.includes(id))),
    })),
  land: (ids) => set((s) => ({ landed: new Set([...s.landed, ...ids.filter((id) => s.hidden.has(id))]) })),
  keepHidden: (present) =>
    set((s) => {
      const next = [...s.hidden].filter((id) => present.has(id));
      return next.length === s.hidden.size ? s : { hidden: new Set(next), landed: new Set([...s.landed].filter((id) => present.has(id))) };
    }),
}));

export const sameKey = (a: ThreadKey | null, b: ThreadKey | null) => a != null && b != null && a.accountId === b.accountId && a.threadId === b.threadId;

export const keyId = (k: ThreadKey) => `${k.accountId}:${k.threadId}`;
