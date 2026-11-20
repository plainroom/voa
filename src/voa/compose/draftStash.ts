/** What Esc threw away, kept in memory only so Undo can bring it back. No drafts, no storage. */
export interface ComposeDraft {
  accountId: string | null;
  to: string[];
  subject: string;
  html: string;
  /** The stored copy of an unsent message this was reopened from: it goes only once this is sent or discarded. */
  unsentId?: string;
}

let stash: ComposeDraft | null = null;

export const stashDraft = (d: ComposeDraft) => void (stash = d);
export const peekDraft = () => stash;
export const clearDraft = () => void (stash = null);

/** The account of the conversation last open, noted by the router (see App): compose's From default. */
let lastOpened: string | null = null;
export const noteOpenThread = (accountId: string) => void (lastOpened = accountId);
export const lastOpenThreadAccount = () => lastOpened;
export const resetLastOpened = () => void (lastOpened = null);
