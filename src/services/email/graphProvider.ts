import type { EmailFolder, EmailProvider, SyncResult } from "./types";
import type { ParsedAttachment, ParsedMessage } from "../gmail/messageParser";
import { GRAPH_FOLDER, type GraphFolder } from "../graph/config";
import type { GraphFile, GraphFolderRow } from "../graph/client";
import { toStoredMessage } from "../graph/message";
import { getGraphClient } from "../graph/tokenManager";
import { getMessagesForThread, replaceMessageId } from "../db/messages";

/**
 * EmailProvider for a personal Outlook or Hotmail mailbox.
 * The inbox sync itself lives in graph/sync.ts, the same split Gmail uses.
 */
export class GraphProvider implements EmailProvider {
  readonly accountId: string;
  readonly type = "graph" as const;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  async listFolders(): Promise<EmailFolder[]> {
    return (await (await getGraphClient(this.accountId)).folders()).map(toEmailFolder);
  }

  async createFolder(name: string, parentPath?: string): Promise<EmailFolder> {
    return toEmailFolder(await (await getGraphClient(this.accountId)).createFolder(name, parentPath));
  }

  async deleteFolder(path: string): Promise<void> {
    await (await getGraphClient(this.accountId)).deleteFolder(path);
  }

  async renameFolder(path: string, newName: string): Promise<void> {
    await (await getGraphClient(this.accountId)).renameFolder(path, newName);
  }

  async initialSync(_daysBack: number, _onProgress?: (phase: string, current: number, total: number) => void): Promise<SyncResult> {
    return { messages: [] };
  }

  async deltaSync(_syncToken: string): Promise<SyncResult> {
    return { messages: [] };
  }

  async fetchMessage(messageId: string): Promise<ParsedMessage> {
    const client = await getGraphClient(this.accountId);
    const [message] = await client.messages([messageId]);
    if (!message) throw new Error("Outlook could not find that message");
    const files = message.hasAttachments ? await client.attachments(messageId) : [];
    return toParsed(message, files);
  }

  async fetchAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
    return (await getGraphClient(this.accountId)).attachment(messageId, attachmentId);
  }

  async fetchRawMessage(messageId: string): Promise<string> {
    return (await getGraphClient(this.accountId)).rawMessage(messageId);
  }

  async archive(_threadId: string, messageIds: string[]): Promise<void> {
    await this.move(messageIds, GRAPH_FOLDER.archive);
  }

  async trash(_threadId: string, messageIds: string[]): Promise<void> {
    await this.move(messageIds, GRAPH_FOLDER.trash);
  }

  async permanentDelete(_threadId: string, messageIds: string[]): Promise<void> {
    const client = await getGraphClient(this.accountId);
    for (const id of messageIds) await client.remove(id);
  }

  async markRead(_threadId: string, messageIds: string[], read: boolean): Promise<void> {
    const client = await getGraphClient(this.accountId);
    for (const id of messageIds) await client.patch(id, { isRead: read });
  }

  async star(_threadId: string, messageIds: string[], starred: boolean): Promise<void> {
    const client = await getGraphClient(this.accountId);
    const flagStatus = starred ? "flagged" : "notFlagged";
    for (const id of messageIds) await client.patch(id, { flag: { flagStatus } });
  }

  async spam(_threadId: string, messageIds: string[], isSpam: boolean): Promise<void> {
    await this.move(messageIds, isSpam ? GRAPH_FOLDER.junk : GRAPH_FOLDER.inbox);
  }

  async moveToFolder(_threadId: string, messageIds: string[], folderPath: string): Promise<void> {
    await this.move(messageIds, folderPath);
  }

  async addLabel(threadId: string, labelId: string): Promise<void> {
    const folder = this.folderFor(labelId);
    if (folder) {
      await this.moveThread(threadId, folder);
      return;
    }
    if (this.localLabel(labelId)) return;
    throw new Error("Outlook does not support labels yet");
  }

  async removeLabel(threadId: string, labelId: string): Promise<void> {
    if (labelId === "INBOX") {
      await this.moveThread(threadId, GRAPH_FOLDER.archive);
      return;
    }
    // Out of Deleted Items or Junk: trash lands in Archive (an Undo that wants the inbox adds INBOX next),
    // and not-spam goes to the inbox, as spam(false) does.
    if (labelId === "TRASH") {
      await this.moveThread(threadId, GRAPH_FOLDER.archive);
      return;
    }
    if (labelId === "SPAM") {
      await this.moveThread(threadId, GRAPH_FOLDER.inbox);
      return;
    }
    if (this.localLabel(labelId)) return;
    throw new Error("Outlook does not support labels yet");
  }

  async sendMessage(rawBase64Url: string, _threadId?: string): Promise<{ id: string }> {
    const client = await getGraphClient(this.accountId);
    await client.sendMail(rawBase64Url);
    return { id: "" };
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const profile = await (await getGraphClient(this.accountId)).profile();
      return { success: true, message: `Connected as ${profile.email}` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Could not reach Microsoft" };
    }
  }

  async getProfile(): Promise<{ email: string; name?: string }> {
    return (await getGraphClient(this.accountId)).profile();
  }

  private async move(messageIds: string[], destination: string): Promise<void> {
    const client = await getGraphClient(this.accountId);
    for (const id of messageIds) {
      const next = await client.move(id, destination);
      if (next && next !== id) await replaceMessageId(this.accountId, id, next);
    }
  }

  private async moveThread(threadId: string, destination: GraphFolder): Promise<void> {
    const ids = (await getMessagesForThread(this.accountId, threadId)).map((message) => message.id);
    await this.move(ids, destination);
  }

  /** Inbox, spam and trash are folders. Starred, snoozed and blocked are only labels here. */
  private folderFor(labelId: string): GraphFolder | null {
    if (labelId === "INBOX") return GRAPH_FOLDER.inbox;
    if (labelId === "SPAM") return GRAPH_FOLDER.junk;
    if (labelId === "TRASH") return GRAPH_FOLDER.trash;
    return null;
  }

  private localLabel(labelId: string): boolean {
    return labelId === "STARRED" || labelId === "SNOOZED" || labelId === "BLOCKED";
  }
}

function toEmailFolder(folder: GraphFolderRow): EmailFolder {
  return {
    id: folder.id,
    name: folder.displayName,
    path: folder.id,
    type: folder.wellKnownName ? "system" : "user",
    specialUse: folder.wellKnownName ?? null,
    delimiter: "/",
    messageCount: folder.totalItemCount ?? 0,
    unreadCount: folder.unreadItemCount ?? 0,
  };
}

function toParsed(message: Parameters<typeof toStoredMessage>[1], files: GraphFile[]): ParsedMessage {
  const stored = toStoredMessage("", message);
  const attachments: ParsedAttachment[] = files.map((file) => ({
    filename: file.name ?? "attachment",
    mimeType: file.contentType ?? "application/octet-stream",
    size: file.size ?? 0,
    gmailAttachmentId: file.id,
    contentId: file.contentId?.replace(/^<|>$/g, "") || null,
    isInline: file.isInline === true,
  }));
  return {
    id: stored.id,
    threadId: stored.threadId,
    fromAddress: stored.fromAddress,
    fromName: stored.fromName,
    toAddresses: stored.toAddresses,
    ccAddresses: stored.ccAddresses,
    bccAddresses: null,
    replyTo: stored.replyTo,
    subject: stored.subject,
    snippet: stored.snippet ?? "",
    date: stored.date,
    isRead: stored.isRead,
    isStarred: stored.isStarred,
    bodyHtml: stored.bodyHtml,
    bodyText: stored.bodyText,
    rawSize: 0,
    internalDate: stored.internalDate,
    labelIds: [],
    hasAttachments: attachments.some((file) => !file.isInline) || message.hasAttachments === true,
    attachments,
    listUnsubscribe: null,
    listUnsubscribePost: null,
    authResults: null,
    messageIdHeader: stored.messageIdHeader,
    referencesHeader: null,
  };
}
