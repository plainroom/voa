import { upsertAttachment } from "../db/attachments";
import { blockedMessageHeaders } from "../db/blockedSenders";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import { finishGraphPass, markGraphPassSeen, saveGraphPassLink, startGraphPass } from "../db/graphPass";
import {
  deleteMessage,
  getMessagesForThread,
  markBodyUnavailable,
  messageIdsWithoutBody,
  noteBodyTry,
  messageThreadId,
  setMessageBody,
  upsertMessage,
} from "../db/messages";
import { deleteThread, getThreadById, getThreadLabelIds, setThreadLabels, threadIdsWithLabel, upsertThread } from "../db/threads";
import { getPendingOpsForResource } from "../db/pendingOperations";
import { getGraphClient } from "./tokenManager";
import { graphMessageDate, graphStarred, graphThreadId, toStoredMessage, type GraphMessage } from "./message";
import { graphCursorExpired, type GraphClient, type GraphDeltaPage } from "./client";

/** Stored messages whose body a run asks for again, newest first. One $batch. */
const MISSING_BODIES_PER_RUN = 20;

/** Pages one run reads. A larger inbox goes on from where it stopped at the next run. */
const MAX_DELTA_PAGES = 40;

/**
 * Pull the inbox through Graph's delta feed.
 * Once the feed has been read to its end, history_id holds the delta link, the same column Gmail uses for its history
 * id, and each run follows it (its next links saved there too, so a long catch-up goes on from where it stopped).
 * Until then, on the first sync or after Microsoft dropped the cursor (410, syncStateNotFound, resyncRequired), the
 * account is in a full pass (db/graphPass.ts): history_id stays null, so the account counts as still syncing, and
 * the pass's next link and the inbox threads it saw are kept apart. Each page is stored and its link saved before the
 * next, so a run cut short goes on from there. At the end of a pass, a thread the local inbox shows that the pass
 * never saw leaves the local inbox.
 */
export async function syncGraphAccount(accountId: string): Promise<boolean> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("Account not found");
  const client = await getGraphClient(accountId);
  const flagged = await client.flagged();
  const flaggedThreads = new Set(flagged.map((message) => graphThreadId(message)));
  const flaggedIds = new Set(flagged.map((message) => message.id));
  const first = account.history_id == null;
  let pass = account.history_id == null;
  let cursor = (pass ? account.graph_next_link : account.history_id) ?? undefined;
  if (pass && cursor === undefined) await startGraphPass(accountId);
  let restarted = false;
  let changed = false;

  for (let page = 0; page < MAX_DELTA_PAGES; page++) {
    let batch: GraphDeltaPage;
    try {
      batch = await client.delta(cursor);
    } catch (err) {
      if (cursor === undefined || restarted || !graphCursorExpired(err)) throw err;
      console.warn(`voa: Microsoft dropped the Outlook sync cursor of ${accountId}, reading the inbox again`);
      await startGraphPass(accountId);
      pass = true;
      cursor = undefined;
      restarted = true;
      continue;
    }
    changed = (await storeDeltaPage(accountId, client, batch.value, flaggedThreads, flaggedIds)) || changed;
    if (pass) {
      await markGraphPassSeen(
        accountId,
        new Set(batch.value.filter((message) => !message["@removed"]).map((message) => graphThreadId(message))),
      );
    }
    if (batch.deltaLink) {
      if (pass) {
        await finishGraphPass(accountId, batch.deltaLink);
        changed = true; // the end of a pass may have taken threads out of the inbox
      } else {
        await updateAccountSyncState(accountId, batch.deltaLink);
      }
      break;
    }
    if (!batch.nextLink) throw new Error("Microsoft did not finish the inbox sync");
    if (pass) await saveGraphPassLink(accountId, batch.nextLink);
    else await updateAccountSyncState(accountId, batch.nextLink);
    cursor = batch.nextLink;
  }

  const starred = new Map<string, GraphMessage[]>();
  for (const message of flagged) {
    const threadId = graphThreadId(message);
    const list = starred.get(threadId) ?? [];
    list.push(message);
    starred.set(threadId, list);
  }
  for (const [threadId, messages] of starred) {
    const missing = [];
    for (const message of messages) {
      if ((await messageThreadId(accountId, message.id)) == null) missing.push(message);
    }
    if (missing.length === 0) continue;
    await storeThread(accountId, threadId, await withBodies(client, messages), false, client);
    changed = true;
  }

  for (const [folder, label] of FOLDER_LISTS) {
    changed = (await syncGraphFolder(accountId, client, folder, label).catch((err) => {
      console.error(`voa could not read the Outlook ${folder} folder:`, err);
      return false;
    })) || changed;
  }
  changed = (await fillMissingBodies(accountId, client)) || changed;
  return first || restarted || changed;
}

/** Outlook folders read into voa's lists, so mail deleted or junked elsewhere shows there too. */
const FOLDER_LISTS = [
  ["deleteditems", "TRASH"],
  ["junkemail", "SPAM"],
] as const;

// ponytail: the newest page every minute at most; older mail in those folders stays out until it is the newest 50.
const FOLDER_EVERY_MS = 60_000;
const folderReadAt = new Map<string, number>();

/**
 * The folder's newest messages, headers only (the body comes on open), labeled `label`. A conversation still in the
 * inbox keeps its place there (one reply deleted is not the conversation). When the page is the whole folder, a
 * conversation labeled `label` it no longer has (restored, emptied, elsewhere) leaves the list, unless voa has a
 * change of its own still on the way.
 */
async function syncGraphFolder(accountId: string, client: GraphClient, folder: string, label: "TRASH" | "SPAM"): Promise<boolean> {
  const key = `${accountId}:${folder}`;
  if (Date.now() - (folderReadAt.get(key) ?? 0) < FOLDER_EVERY_MS) return false;
  folderReadAt.set(key, Date.now());
  const { value, complete } = await client.folderMessages(folder);
  await storeFound(accountId, client, value, await client.folderId("inbox"), true);
  let changed = false;
  const seen = new Set(value.map((message) => graphThreadId(message)));
  for (const threadId of seen) {
    const labels = await getThreadLabelIds(accountId, threadId);
    if (labels.includes(label) || labels.includes("INBOX")) continue;
    await setThreadLabels(accountId, threadId, [...labels.filter((l) => l !== "TRASH" && l !== "SPAM"), label]);
    changed = true;
  }
  if (!complete) return changed;
  for (const threadId of await threadIdsWithLabel(accountId, label)) {
    if (seen.has(threadId) || (await getPendingOpsForResource(accountId, threadId)).length > 0) continue;
    await setThreadLabels(accountId, threadId, (await getThreadLabelIds(accountId, threadId)).filter((l) => l !== label));
    changed = true;
  }
  return changed;
}

/**
 * A message whose body Microsoft did not give when it was stored (throttled, busy) is stored without one; each run
 * asks again for a few, the least tried first. One Microsoft no longer has (404) is unavailable at once; one still
 * not given counts a try, and is unavailable after `MAX_BODY_TRIES`. Best effort: a failure here waits for the next run
 * and never fails this one.
 */
async function fillMissingBodies(accountId: string, client: GraphClient): Promise<boolean> {
  try {
    const ids = await messageIdsWithoutBody(accountId, MISSING_BODIES_PER_RUN);
    if (ids.length === 0) return false;
    const gone = new Set<string>();
    const found = (await client.messages(ids, gone)).filter((message) => message.body?.content != null);
    for (const message of found) {
      const row = toStoredMessage(accountId, message);
      await setMessageBody(accountId, message.id, row.bodyHtml, row.bodyText);
    }
    const given = new Set(found.map((message) => message.id));
    for (const id of ids) {
      if (gone.has(id)) await markBodyUnavailable(accountId, id);
      else if (!given.has(id)) await noteBodyTry(accountId, id);
    }
    return given.size > 0 || gone.size > 0;
  } catch (err) {
    console.warn(`voa could not fetch missing Outlook bodies for ${accountId}:`, err);
    return false;
  }
}

/** One delta page: removals as they come, then each conversation it touched. True when anything changed. */
async function storeDeltaPage(
  accountId: string,
  client: GraphClient,
  page: GraphMessage[],
  flaggedThreads: Set<string>,
  flaggedIds: Set<string>,
): Promise<boolean> {
  let changed = false;
  const seen = new Map<string, GraphMessage[]>();
  for (const message of page) {
    if (message["@removed"]) {
      changed = (await removeFromInbox(accountId, message.id, flaggedThreads, flaggedIds)) || changed;
      continue;
    }
    const threadId = graphThreadId(message);
    const list = seen.get(threadId) ?? [];
    list.push(message);
    seen.set(threadId, list);
  }
  for (const [threadId, messages] of seen) {
    await storeThread(accountId, threadId, await withBodies(client, messages), true, client);
    changed = true;
  }
  return changed;
}

async function withBodies(client: Awaited<ReturnType<typeof getGraphClient>>, messages: GraphMessage[]): Promise<GraphMessage[]> {
  const missing = messages.filter((message) => !message.body?.content).map((message) => message.id);
  const full = new Map<string, GraphMessage>();
  for (let index = 0; index < missing.length; index += 20) {
    for (const message of await client.messages(missing.slice(index, index + 20))) full.set(message.id, message);
  }
  return messages.map((message) => full.get(message.id) ?? message);
}

async function storeAttachments(client: GraphClient, accountId: string, messages: GraphMessage[]): Promise<void> {
  for (const message of messages) {
    if (message.hasAttachments !== true) continue;
    let files: Awaited<ReturnType<GraphClient["attachments"]>> = [];
    try {
      files = await client.attachments(message.id);
    } catch (err) {
      console.error(`voa could not list attachments for ${message.id}:`, err);
      continue;
    }
    for (const file of files) {
      const contentId = file.contentId?.replace(/^<|>$/g, "") || null;
      await upsertAttachment({
        id: `${message.id}:${file.id}`,
        messageId: message.id,
        accountId,
        filename: file.name ?? (contentId ? null : "attachment"),
        mimeType: file.contentType ?? null,
        size: file.size ?? null,
        gmailAttachmentId: file.id,
        contentId,
        isInline: file.isInline === true,
      });
    }
  }
}

/**
 * Search reaches mail the inbox sync has not stored yet. One page, the same bound Gmail uses, stored with headers
 * and preview only: the body comes when the conversation opens (`fetchGraphBodies`). An aborted search stores nothing.
 */
export async function syncGraphSearch(accountId: string, query: string, signal?: AbortSignal): Promise<void> {
  const client = await getGraphClient(accountId);
  const found = await client.search(query);
  const inboxId = await client.folderId("inbox");
  if (signal?.aborted) return;
  await storeFound(accountId, client, found, inboxId, true);
}

/**
 * The bodies (and files) of messages a search stored with headers only. What Microsoft does not answer stays waiting;
 * what it no longer has (404) is unavailable, never waiting forever.
 */
export async function fetchGraphBodies(accountId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const client = await getGraphClient(accountId);
  const found: GraphMessage[] = [];
  const gone = new Set<string>();
  for (let index = 0; index < messageIds.length; index += 20) found.push(...(await client.messages(messageIds.slice(index, index + 20), gone)));
  for (const id of gone) await markBodyUnavailable(accountId, id);
  for (const message of found) {
    // The whole row (recipients, Message-ID: the light search had none), then no longer waiting, even with an empty body.
    const row = toStoredMessage(accountId, message);
    await upsertMessage(row);
    await setMessageBody(accountId, message.id, row.bodyHtml, row.bodyText);
  }
  await storeAttachments(client, accountId, found);
}

/**
 * Mail a block archived, and that a later sync had already dropped, comes back to the inbox. Only messages the block
 * recorded: mail from the sender archived by hand stays in Archive.
 */
/**
 * Returns to the inbox what a block archived (by Message-ID), reading every page of the sender's mail. Returns the
 * Message-IDs that need nothing more: moved back, already on disk (the local Unblock returned them), or no longer in
 * Archive. A failed move or a message the search did not find stays out, so a later Unblock can try it again.
 */
export async function restoreGraphSender(accountId: string, address: string): Promise<string[]> {
  const archivedByBlock = await blockedMessageHeaders(accountId, address);
  if (archivedByBlock.size === 0) return [];
  const client = await getGraphClient(accountId);
  const [inboxId, archiveId] = await Promise.all([client.folderId("inbox"), client.folderId("archive")]);
  const done = new Set<string>();
  const returning: GraphMessage[] = [];
  for await (const page of client.searchPages(`from:${address}`)) {
    for (const message of page) {
      const header = message.internetMessageId;
      if (!header || !archivedByBlock.has(header) || done.has(header)) continue;
      if ((await messageThreadId(accountId, message.id)) != null || message.parentFolderId !== archiveId) {
        done.add(header);
        continue;
      }
      try {
        const next = await client.move(message.id, "inbox");
        if (next) message.id = next;
        message.parentFolderId = inboxId;
        returning.push(message);
        done.add(header);
      } catch (err) {
        console.error("voa could not return a blocked message:", err);
      }
    }
    if (done.size === archivedByBlock.size) break;
  }
  await storeFound(accountId, client, returning, inboxId);
  return [...done];
}

async function storeFound(accountId: string, client: GraphClient, found: GraphMessage[], inboxId: string, headersOnly = false): Promise<void> {
  const byThread = new Map<string, GraphMessage[]>();
  for (const message of found) {
    const threadId = graphThreadId(message);
    const list = byThread.get(threadId) ?? [];
    list.push(message);
    byThread.set(threadId, list);
  }
  for (const [threadId, messages] of byThread) {
    const missing: GraphMessage[] = [];
    for (const message of messages) {
      if ((await messageThreadId(accountId, message.id)) == null) missing.push(message);
    }
    if (missing.length === 0) continue;
    const inInbox = messages.some((message) => message.parentFolderId === inboxId);
    // Headers only: just the messages not on disk, so a light row never lands over one stored whole.
    await storeThread(accountId, threadId, headersOnly ? missing : await withBodies(client, messages), inInbox, client, headersOnly);
  }
}

async function storeThread(
  accountId: string,
  threadId: string,
  messages: GraphMessage[],
  inInbox: boolean,
  client: GraphClient,
  bodyPending = false,
): Promise<void> {
  const ordered = [...messages].sort((a, b) => graphMessageDate(a) - graphMessageDate(b));
  const earliest = ordered[0];
  const latest = ordered[ordered.length - 1];
  if (!earliest || !latest) return;
  // A search's headers-only messages joining a conversation already stored leave its labels and files as they are.
  const before = bodyPending ? await getThreadById(accountId, threadId) : undefined;
  // The message row points at this thread. The thread has to exist first.
  await upsertThread({
    id: threadId,
    accountId,
    subject: earliest.subject ?? null,
    snippet: latest.bodyPreview ?? "",
    lastMessageAt: graphMessageDate(latest),
    messageCount: ordered.length,
    isRead: ordered.every((message) => message.isRead !== false),
    isStarred: ordered.some((message) => graphStarred(message)),
    isImportant: false,
    hasAttachments: ordered.some((message) => message.hasAttachments === true),
  });
  for (const message of ordered) await upsertMessage({ ...toStoredMessage(accountId, message), bodyPending });
  await storeAttachments(client, accountId, ordered);

  const stored = await getMessagesForThread(accountId, threadId);
  const first = stored[0];
  const last = stored[stored.length - 1];
  if (!first || !last) return;
  await upsertThread({
    id: threadId,
    accountId,
    subject: first.subject,
    snippet: last.snippet ?? "",
    lastMessageAt: last.date,
    messageCount: stored.length,
    isRead: stored.every((message) => message.is_read === 1),
    isStarred: stored.some((message) => message.is_starred === 1),
    isImportant: false,
    hasAttachments: before?.has_attachments === 1 || ordered.some((message) => message.hasAttachments === true),
  });
  if (before) return;
  const already = await getThreadLabelIds(accountId, threadId);
  const labels: string[] = [];
  if (inInbox || already.includes("INBOX")) labels.push("INBOX");
  if (messages.some((message) => graphStarred(message)) || stored.some((message) => message.is_starred === 1)) labels.push("STARRED");
  // A flagged copy can land after spam or trash. Those labels are the list the message still belongs to.
  if (!inInbox) {
    for (const label of ["SPAM", "TRASH"]) {
      if (already.includes(label)) labels.push(label);
    }
  }
  await setThreadLabels(accountId, threadId, labels);
}

async function removeFromInbox(
  accountId: string,
  messageId: string,
  flaggedThreads: Set<string>,
  flaggedIds: Set<string>,
): Promise<boolean> {
  const threadId = await messageThreadId(accountId, messageId);
  if (!threadId) return false;
  const labels = await getThreadLabelIds(accountId, threadId);
  const keep = flaggedThreads.has(threadId) || labels.some((label) => label !== "INBOX");
  if (!keep) {
    await deleteMessage(accountId, messageId);
    const left = await getMessagesForThread(accountId, threadId);
    if (left.length === 0) await deleteThread(accountId, threadId);
    return true;
  }
  // A move gives the message a new id. Drop the stale copy; snooze and spam keep the one they have.
  if (flaggedThreads.has(threadId) && !flaggedIds.has(messageId)) await deleteMessage(accountId, messageId);
  const next = labels.filter((label) => label !== "INBOX");
  if (flaggedThreads.has(threadId) && !next.includes("STARRED")) next.push("STARRED");
  await setThreadLabels(accountId, threadId, next);
  return true;
}
