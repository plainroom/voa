/** A Microsoft Graph message, the fields voa stores. */
export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  isRead?: boolean;
  flag?: { flagStatus?: string };
  body?: { contentType?: string; content?: string };
  internetMessageId?: string;
  hasAttachments?: boolean;
  parentFolderId?: string;
  "@removed"?: { reason?: string };
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface StoredGraphMessage {
  id: string;
  accountId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  bccAddresses: null;
  replyTo: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  rawSize: null;
  internalDate: number;
  messageIdHeader: string | null;
}

export function graphThreadId(message: GraphMessage): string {
  return message.conversationId || message.id;
}

export function graphStarred(message: GraphMessage): boolean {
  return message.flag?.flagStatus === "flagged";
}

export function graphMessageDate(message: GraphMessage): number {
  const parsed = message.receivedDateTime ? Date.parse(message.receivedDateTime) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function formatRecipients(recipients: GraphRecipient[] | undefined): string | null {
  if (!recipients?.length) return null;
  const line = recipients
    .map((recipient) => {
      const address = recipient.emailAddress?.address;
      const name = recipient.emailAddress?.name;
      if (!address) return name ?? "";
      return name ? `${name} <${address}>` : address;
    })
    .filter(Boolean)
    .join(", ");
  return line || null;
}

/** The row the inbox already understands. HTML stays HTML. A flag is a star. */
export function toStoredMessage(accountId: string, message: GraphMessage): StoredGraphMessage {
  const html = message.body?.contentType?.toLowerCase() === "html" ? message.body.content ?? null : null;
  const date = graphMessageDate(message);
  return {
    id: message.id,
    accountId,
    threadId: graphThreadId(message),
    fromAddress: message.from?.emailAddress?.address ?? null,
    fromName: message.from?.emailAddress?.name ?? null,
    toAddresses: formatRecipients(message.toRecipients),
    ccAddresses: formatRecipients(message.ccRecipients),
    bccAddresses: null,
    replyTo: formatRecipients(message.replyTo),
    subject: message.subject ?? null,
    snippet: message.bodyPreview ?? null,
    date,
    isRead: message.isRead !== false,
    isStarred: graphStarred(message),
    bodyHtml: html,
    bodyText: html ? null : message.body?.content ?? null,
    rawSize: null,
    internalDate: date,
    messageIdHeader: message.internetMessageId ?? null,
  };
}
