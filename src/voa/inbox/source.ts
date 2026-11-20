import { getAccount, getAllAccounts } from "@/services/db/accounts";
import { getAttachmentsForMessage, type DbAttachment } from "@/services/db/attachments";
import { getAllowlistedSenders } from "@/services/db/imageAllowlist";
import { openAttachment } from "@/services/attachments/openAttachment";
import { getMessagesForThread, pendingBodyIds, type DbMessage } from "@/services/db/messages";
import { upsertContact } from "@/services/db/contacts";
import { getSetting, setSetting } from "@/services/db/settings";
import { getDb } from "@/services/db/connection";
import { addLocalLabel, getLabelCounts, getPromotionThreads, getThreadById, getThreads, removeLocalLabel, type DbThread, type ThreadKey } from "@/services/db/threads";
import { reauthorizeAccount } from "@/services/gmail/tokenManager";
import { reauthorizeGraphAccount } from "@/services/graph/auth";
import { archiveThread, archiveThreads, markThreadRead, sendEmail, spamThread, starThread, trashThread, trashThreads, unarchiveThread, untrashThread, wasInInboxBeforeTrash, type ActionResult } from "@/services/emailActions";
import { blockedThreadIdsFromSender, blockSender, forgetBlockedMessages, inboxThreadIdsFromSender, recordBlockedMessages, unblockSender } from "@/services/db/blockedSenders";
import { getOwnAddresses, setSendAsAliases } from "@/services/db/sendAsAliases";
import { normalizeEmail } from "@/utils/emailUtils";
import { cancelRemind, remindLater } from "@/services/snooze/snoozeManager";
import { buildRawEmail } from "@/utils/emailBuilder";
import { searchThreads, type SearchHit } from "../search/searchThreads";
import type { InboxList } from "@/stores/list";
import { setSignedOut } from "@/services/oauth/signedOut";

export interface InboxAccount {
  id: string;
  name: string;
  email: string;
  color: string | null;
  /** Whether a first sync ever completed (until then an empty inbox proves nothing). */
  synced: boolean;
}

/** Where the inbox reads and acts. The app uses the real one; the browser demo swaps in a fixture. */
export interface InboxSource {
  accounts(): Promise<InboxAccount[]>;
  threads(list: InboxList, accountIds?: string[]): Promise<DbThread[]>;
  /** Inbox threads Gmail filed as Promotions. They are not in `threads("INBOX")`. */
  promotions(): Promise<DbThread[]>;
  thread(key: ThreadKey): Promise<DbThread | undefined>;
  counts(list: InboxList): Promise<Record<string, number>>;
  archive(key: ThreadKey): Promise<void>;
  /** Archive a batch. Local rows leave before the first send, so a sync cannot bring them back. */
  archiveMany(keys: readonly ThreadKey[]): Promise<void>;
  unarchive(key: ThreadKey): Promise<void>;
  /** Move to trash. From Spam this is Delete. */
  trash(key: ThreadKey): Promise<void>;
  /** Trash a batch. Local rows leave before the first send, so a sync cannot bring them back. */
  trashMany(keys: readonly ThreadKey[]): Promise<void>;
  /**
   * Undo a delete. `restore` is the list label to put back (inbox or spam).
   * Starred and snoozed keep their own label, so they pass null: the thread returns to the inbox only if it was there.
   */
  untrash(key: ThreadKey, restore?: "INBOX" | "SPAM" | null): Promise<void>;
  star(key: ThreadKey, starred: boolean): Promise<void>;
  /** Snooze until `until` (unix seconds), or move the time of one already snoozed. */
  remind(key: ThreadKey, until: number): Promise<void>;
  /** Back to the inbox now. */
  unremind(key: ThreadKey): Promise<void>;
  /** Re-authorize a failing account in place (its tokens change, nothing else) and sync it again. */
  reconnect(accountId: string): Promise<void>;
  /** The conversation's messages, oldest first. */
  messages(key: ThreadKey): Promise<DbMessage[]>;
  markRead(key: ThreadKey): Promise<void>;
  /** A message's attachments, the inline images (content_id) among them. */
  attachments(accountId: string, messageId: string): Promise<DbAttachment[]>;
  /** Downloads the file and opens it with its app. Throws when it could not. */
  openAttachment(attachment: DbAttachment): Promise<void>;
  /** Whether remote images stay blocked (only when the owner chose it in Settings), and the senders the owner always loads them from. */
  /** Spam never loads remote images by itself (a tracking pixel confirms the address): no setting or allowlist changes that. */
  imagePolicy(key: ThreadKey, senders: string[]): Promise<{ block: boolean; allowed: ReadonlySet<string> }>;
  /** Conversations on disk matching the text, over every account, newest first. Local only: it answers at once. */
  search(query: string): Promise<SearchHit[]>;
  /**
   * Asks every mailbox for the query, in parallel, and stores the conversations it names that are not on disk yet
   * (headers only). `onStored` runs after each account answers, so the screen searches the disk again. An account that
   * fails or is throttled only adds nothing. Resolves when every account answered or the signal aborted.
   */
  searchRemote(query: string, opts: { signal: AbortSignal; onStored: () => void }): Promise<void>;
  /** Fetches the bodies of the conversation's messages a search stored with headers only. */
  fetchBodies(key: ThreadKey): Promise<void>;
  /** Sends a new message from the account. Throws when it could not. */
  send(accountId: string, message: OutgoingMessage): Promise<void>;
  /** The account the owner last sent from. */
  lastFromAccount(): Promise<string | null>;
  setLastFromAccount(accountId: string): Promise<void>;
  /** Mark the conversation as spam, or put it back. */
  spam(key: ThreadKey): Promise<void>;
  unspam(key: ThreadKey): Promise<void>;
  /** One-click, mailto, or the browser. Throws when none of them worked. */
  unsubscribe(key: ThreadKey): Promise<void>;
  /**
   * Keep this sender out of the inbox: the conversations already there, and any a later sync brings back.
   * Returns the address and the conversations it archived.
   */
  block(key: ThreadKey): Promise<{ address: string; threads: ThreadKey[] }>;
  unblock(accountId: string, address: string): Promise<void>;
}

export interface OutgoingMessage {
  /** The account's address. */
  from: string;
  to: string[];
  subject: string;
  html: string;
}

/** The tab name is the address. A display name would hide which mailbox it is. */
function accountNames(accounts: { id: string; email: string }[]): Record<string, string> {
  return Object.fromEntries(accounts.map((a) => [a.id, a.email]));
}

const messageIds = async (k: ThreadKey) => (await getMessagesForThread(k.accountId, k.threadId)).map((m) => m.id);

/** The latest person in the conversation who is not the account's owner (the account or one of its send-as aliases). */
async function otherParty(k: ThreadKey): Promise<string | null> {
  const [account, messages] = await Promise.all([getAccount(k.accountId), getMessagesForThread(k.accountId, k.threadId)]);
  if (account?.provider === "gmail_api") await refreshGmailAliases(k.accountId);
  const mine = await getOwnAddresses(k.accountId, account?.email);
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = messages[i]?.from_address;
    if (!from) continue;
    const address = normalizeEmail(from);
    if (address && !mine.has(address)) return address;
  }
  return null;
}

/** Gmail's send-as list, read before a block so an alias is never taken for the sender. Kept as it was when Gmail cannot answer. */
async function refreshGmailAliases(accountId: string): Promise<void> {
  if (!("__TAURI_INTERNALS__" in globalThis)) return;
  try {
    const { getGmailClient } = await import("@/services/gmail/tokenManager");
    const { sendAs } = await (await getGmailClient(accountId)).listSendAs();
    if (sendAs?.length) await setSendAsAliases(accountId, sendAs.map((alias) => alias.sendAsEmail));
  } catch (err) {
    console.error("voa could not read the send-as addresses:", err);
  }
}

/** A send whose outcome is unknown: it may have gone, so it is not sent again. */
export class MaybeSentError extends Error {
  constructor() {
    super("The message may have been sent");
    this.name = "MaybeSentError";
  }
}

function ok(result: ActionResult): void {
  if (!result.success) throw new Error(result.error ?? "Action failed");
}

/**
 * "true" when the owner chose to block remote images (Settings); absent or anything else loads them.
 * Not Velo's `block_remote_images`, which its migration set to "true" in every database.
 */
export const BLOCK_IMAGES_SETTING = "voa_block_remote_images";

export const realSource: InboxSource = {
  async accounts() {
    const rows = (await getAllAccounts()).filter((a) => a.is_active === 1 && a.provider !== "caldav");
    const names = accountNames(rows);
    return rows.map((a) => ({ id: a.id, name: names[a.id]!, email: a.email, color: a.color, synced: a.history_id != null }));
  },
  threads: (list, accountIds) => getThreads({ labelId: list, accountIds, limit: 500 }),
  promotions: () => getPromotionThreads(),
  thread: (k) => getThreadById(k.accountId, k.threadId),
  counts: (list) => getLabelCounts(list),
  async archive(k) {
    ok(await archiveThread(k.accountId, k.threadId, await messageIds(k)));
  },
  async archiveMany(keys) {
    ok(
      await archiveThreads(
        await Promise.all(keys.map(async (k) => ({ accountId: k.accountId, threadId: k.threadId, messageIds: await messageIds(k) }))),
      ),
    );
  },
  async unarchive(k) {
    ok(await unarchiveThread(k.accountId, k.threadId));
  },
  async trash(k) {
    ok(await trashThread(k.accountId, k.threadId, await messageIds(k)));
  },
  async trashMany(keys) {
    ok(
      await trashThreads(
        await Promise.all(keys.map(async (k) => ({ accountId: k.accountId, threadId: k.threadId, messageIds: await messageIds(k) }))),
      ),
    );
  },
  async untrash(k, restore = "SPAM") {
    // From Starred or Snoozed the list does not say where the thread was: it goes back to the inbox only if it was there.
    const back = restore ?? (wasInInboxBeforeTrash(k.accountId, k.threadId) ? "INBOX" : null);
    ok(await untrashThread(k.accountId, k.threadId, back));
  },
  async star(k, starred) {
    ok(await starThread(k.accountId, k.threadId, await messageIds(k), starred));
  },
  async remind(k, until) {
    await remindLater(k, await messageIds(k), until);
  },
  async unremind(k) {
    await cancelRemind(k, await messageIds(k));
  },
  async reconnect(accountId) {
    const account = await getAccount(accountId);
    if (!account) throw new Error("Account not found");
    if (account.provider === "imap" || account.provider === "caldav") throw new Error("Reconnect works for Gmail accounts; check this account's settings");
    if (account.provider === "graph") await reauthorizeGraphAccount(accountId);
    else await reauthorizeAccount(accountId, account.email);
    setSignedOut(accountId, false);
    // Loaded here: syncManager reaches the router, which the screens' tests do not want.
    const { syncAccount } = await import("@/services/gmail/syncManager");
    void syncAccount(accountId);
  },
  messages: (k) => getMessagesForThread(k.accountId, k.threadId),
  async markRead(k) {
    ok(await markThreadRead(k.accountId, k.threadId, await messageIds(k), true));
  },
  attachments: getAttachmentsForMessage,
  openAttachment,
  async imagePolicy(k, senders) {
    const db = await getDb();
    const spam = await db.select<unknown[]>("SELECT 1 FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'", [k.accountId, k.threadId]);
    if (spam.length > 0) return { block: true, allowed: new Set<string>() };
    const [block, allowed] = await Promise.all([getSetting(BLOCK_IMAGES_SETTING), getAllowlistedSenders(k.accountId, senders)]);
    return { block: block === "true", allowed };
  },
  search: searchThreads,
  searchRemote: (query, { signal, onStored }) => pullRemoteMatches(query, signal, onStored),
  async fetchBodies(k) {
    const ids = await pendingBodyIds(k.accountId, k.threadId);
    if (ids.length === 0) return;
    const account = await getAccount(k.accountId);
    if (account?.provider === "graph") {
      const { fetchGraphBodies } = await import("@/services/graph/sync");
      await fetchGraphBodies(k.accountId, ids);
      return;
    }
    const { getGmailClient } = await import("@/services/gmail/tokenManager");
    const { fetchGmailBodies } = await import("@/services/gmail/sync");
    await fetchGmailBodies(await getGmailClient(k.accountId), k.accountId, k.threadId);
  },
  async send(accountId, m) {
    const result = await sendEmail(accountId, buildRawEmail({ from: m.from, to: m.to, subject: m.subject, htmlBody: m.html }));
    if (result.uncertain) throw new MaybeSentError();
    ok(result);
    for (const address of m.to) await upsertContact(address, null).catch(() => {});
  },
  lastFromAccount: () => getSetting("last_from_account"),
  setLastFromAccount: (id) => setSetting("last_from_account", id),
  async spam(k) {
    ok(await spamThread(k.accountId, k.threadId, await messageIds(k), true));
  },
  async unspam(k) {
    ok(await spamThread(k.accountId, k.threadId, await messageIds(k), false));
  },
  async unsubscribe(k) {
    const messages = await getMessagesForThread(k.accountId, k.threadId);
    const message = [...messages].reverse().find((m) => m.list_unsubscribe && m.from_address);
    if (!message?.list_unsubscribe || !message.from_address) throw new Error("No unsubscribe");
    const { executeUnsubscribe } = await import("@/services/unsubscribe/unsubscribeManager");
    const result = await executeUnsubscribe(k.accountId, k.threadId, message.from_address, message.from_name, message.list_unsubscribe, message.list_unsubscribe_post);
    if (!result.success) throw new Error("Couldn't unsubscribe");
  },
  async block(k) {
    const address = await otherParty(k);
    if (!address) throw new Error("No sender");
    await blockSender(k.accountId, address);
    const ids = await inboxThreadIdsFromSender(k.accountId, address);
    const threads = ids.map((threadId) => ({ accountId: k.accountId, threadId }));
    if (!threads.some((t) => t.threadId === k.threadId)) threads.unshift(k);
    for (const t of threads) {
      const messages = await getMessagesForThread(t.accountId, t.threadId);
      await recordBlockedMessages(t.accountId, address, messages.flatMap((m) => (m.message_id_header ? [m.message_id_header] : [])));
      await addLocalLabel(t.accountId, t.threadId, "BLOCKED");
      ok(await archiveThread(t.accountId, t.threadId, messages.map((m) => m.id)));
    }
    return { address, threads };
  },
  async unblock(accountId, address) {
    await unblockSender(accountId, address);
    for (const threadId of await blockedThreadIdsFromSender(accountId, address)) {
      await removeLocalLabel(accountId, threadId, "BLOCKED");
      ok(await unarchiveThread(accountId, threadId));
    }
    const account = await getAccount(accountId);
    if (account?.provider === "graph" && "__TAURI_INTERNALS__" in globalThis) {
      const { restoreGraphSender } = await import("@/services/graph/sync");
      try {
        // Only what came back is forgotten: the rest stays, so a later Unblock of the same sender can still find it.
        await forgetBlockedMessages(accountId, address, await restoreGraphSender(accountId, address));
      } catch (err) {
        console.error("voa could not restore blocked mail:", err);
      }
      return;
    }
    await forgetBlockedMessages(accountId, address);
  },
};

/** Archived mail is not all on disk. Ask each mailbox for the query and store, headers only, the conversations it names. */
async function pullRemoteMatches(query: string, signal: AbortSignal, onStored: () => void): Promise<void> {
  if (!query.trim() || !("__TAURI_INTERNALS__" in globalThis)) return;
  let accounts;
  try {
    accounts = (await getAllAccounts()).filter((a) => a.is_active === 1 && (a.provider === "gmail_api" || a.provider === "graph"));
  } catch (err) {
    console.error("voa search fetch failed:", err);
    return;
  }
  await Promise.all(
    accounts.map(async (a) => {
      try {
        if (a.provider === "graph") {
          const { syncGraphSearch } = await import("@/services/graph/sync");
          await syncGraphSearch(a.id, query, signal);
        } else {
          const { getGmailClient } = await import("@/services/gmail/tokenManager");
          const { storeQueryThreads } = await import("@/services/gmail/sync");
          await storeQueryThreads(await getGmailClient(a.id), a.id, query, signal);
        }
        if (!signal.aborted) onStored();
      } catch (err) {
        // A throttled or failing account adds nothing this time; the others are not held.
        console.warn(`voa search fetch failed for ${a.email}:`, err);
      }
    }),
  );
}

let active: InboxSource = realSource;

export const inboxSource = (): InboxSource => active;

/** Only the browser demo calls this (see src/voa/demo). */
export function setDemoSource(source: InboxSource): void {
  active = source;
}
