import { refreshAccessToken, type TokenResponse } from "./auth";
import { setSignedOut, SignedOutError } from "../oauth/signedOut";
import { getDb } from "../db/connection";
import { encryptValue } from "@/utils/crypto";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { costOf, GmailNotFoundError, GmailRateLimitError, isRateLimited, quotaFor, retryDelayMs, type QuotaBudget } from "./quota";

export { GmailRateLimitError } from "./quota";

const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1";
const MAX_RATE_LIMIT_ATTEMPTS = 7;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Gmail API client with automatic token refresh.
 */
export class GmailClient {
  private accountId: string;
  private clientId: string;
  private clientSecret?: string;
  private tokenInfo: TokenInfo;
  private refreshPromise: Promise<void> | null = null;
  private readonly quota: QuotaBudget;

  constructor(accountId: string, clientId: string, tokenInfo: TokenInfo, clientSecret?: string) {
    this.accountId = accountId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenInfo = tokenInfo;
    this.quota = quotaFor(accountId);
  }

  private async getValidToken(): Promise<string> {
    const now = getCurrentUnixTimestamp();
    // Refresh if token expires within 5 minutes
    if (this.tokenInfo.expiresAt - now < 300) {
      // Mutex: only one refresh at a time; concurrent callers await the same promise
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshToken().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
    }
    return this.tokenInfo.accessToken;
  }

  private async refreshToken(): Promise<void> {
    const tokens: TokenResponse = await refreshAccessToken(this.tokenInfo.refreshToken, this.clientId, this.clientSecret).catch((err: unknown) => {
      if (err instanceof SignedOutError) setSignedOut(this.accountId, true);
      throw err;
    });
    setSignedOut(this.accountId, false);

    const expiresAt = getCurrentUnixTimestamp() + tokens.expires_in;

    this.tokenInfo = {
      accessToken: tokens.access_token,
      refreshToken: this.tokenInfo.refreshToken,
      expiresAt,
    };

    // Persist the new token (encrypted)
    const db = await getDb();
    const encAccessToken = await encryptValue(tokens.access_token);
    await db.execute(
      "UPDATE accounts SET access_token = $1, token_expires_at = $2, updated_at = unixepoch() WHERE id = $3",
      [encAccessToken, expiresAt, this.accountId],
    );
  }

  /**
   * Fetch, waiting and trying again while Gmail says the account is over its quota (429, or 403
   * with a rate-limit reason): the Retry-After it gives, or 1 s doubling up to 32 s, with jitter.
   * Gives up with a `GmailRateLimitError` after `MAX_RATE_LIMIT_ATTEMPTS`. Any other answer, a 403
   * for a permission or a disabled API included, comes back at once, with its body read when it was
   * needed to tell (`body`). Every attempt spends its cost on the account's quota.
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    cost: number,
  ): Promise<{ response: Response; body?: string }> {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) this.quota.spend(cost);
      const response = await fetch(url, options);
      if (response.status !== 429 && response.status !== 403) return { response };
      const body = await response.text();
      if (!isRateLimited(response.status, body)) return { response, body };
      if (attempt >= MAX_RATE_LIMIT_ATTEMPTS) {
        throw new GmailRateLimitError(`Gmail API error: ${response.status} ${body}`);
      }
      await sleep(retryDelayMs(response.headers.get("Retry-After"), attempt));
    }
  }

  /**
   * `background` work (the first sync's backfill) waits for room in the account's quota before
   * going out; everything else goes at once and only counts.
   */
  async request<T>(
    path: string,
    options: RequestInit = {},
    { background = false }: { background?: boolean } = {},
  ): Promise<T> {
    const cost = costOf(options.method ?? "GET", path);
    if (background) await this.quota.reserve(cost);
    else this.quota.spend(cost);

    const token = await this.getValidToken();
    const url = path.startsWith("http")
      ? path
      : `${GMAIL_API_BASE}/users/me${path}`;

    let { response, body } = await this.fetchWithRetry(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    }, cost);

    if (response.status === 401) {
      // Token might have been revoked: force refresh through the mutex
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshToken().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
      const retryToken = this.tokenInfo.accessToken;
      this.quota.spend(cost);
      ({ response, body } = await this.fetchWithRetry(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${retryToken}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }, cost));
    }

    if (!response.ok) {
      const message = `Gmail API error: ${response.status} ${body ?? (await response.text())}`;
      throw response.status === 404 ? new GmailNotFoundError(message) : new Error(message);
    }

    if (response.status === 204) return undefined as T;
    return response.json();
  }

  async getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }> {
    return this.request("/profile");
  }

  /** The addresses this mailbox sends as (the account itself and its aliases). */
  async listSendAs(): Promise<{ sendAs?: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; isDefault?: boolean }[] }> {
    return this.request("/settings/sendAs");
  }

  async listLabels(): Promise<{ labels: GmailLabel[] }> {
    return this.request("/labels");
  }

  async listThreads(params: {
    labelIds?: string[];
    maxResults?: number;
    pageToken?: string;
    q?: string;
  } = {}, opts: { background?: boolean } = {}): Promise<{ threads?: GmailThreadStub[]; nextPageToken?: string; resultSizeEstimate?: number }> {
    const searchParams = new URLSearchParams();
    if (params.labelIds) searchParams.set("labelIds", params.labelIds.join(","));
    if (params.maxResults) searchParams.set("maxResults", String(params.maxResults));
    if (params.pageToken) searchParams.set("pageToken", params.pageToken);
    if (params.q) searchParams.set("q", params.q);
    const qs = searchParams.toString();
    return this.request(`/threads${qs ? `?${qs}` : ""}`, {}, opts);
  }

  async getThread(
    threadId: string,
    format: "full" | "metadata" | "minimal" = "full",
    opts: { background?: boolean } = {},
  ): Promise<GmailThread> {
    return this.request(`/threads/${threadId}?format=${format}`, {}, opts);
  }

  async getMessage(messageId: string, format: "full" | "metadata" | "minimal" | "raw" = "full"): Promise<GmailMessage> {
    return this.request(`/messages/${messageId}?format=${format}`);
  }

  async modifyThread(threadId: string, addLabelIds?: string[], removeLabelIds?: string[]): Promise<GmailThread> {
    return this.request(`/threads/${threadId}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  async getHistory(
    startHistoryId: string,
    historyTypes: string[] = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
    pageToken?: string,
  ): Promise<{
    history?: GmailHistoryItem[];
    historyId: string;
    nextPageToken?: string;
  }> {
    const params = new URLSearchParams({ startHistoryId });
    for (const ht of historyTypes) {
      params.append("historyTypes", ht);
    }
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    return this.request(`/history?${params.toString()}`);
  }

  /**
   * Create a new user label.
   */
  async createLabel(name: string, color?: { textColor: string; backgroundColor: string }): Promise<GmailLabel> {
    const body: Record<string, unknown> = {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    };
    if (color) body.color = color;
    return this.request("/labels", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Update an existing label's name and/or color.
   */
  async updateLabel(labelId: string, updates: { name?: string; color?: { textColor: string; backgroundColor: string } | null }): Promise<GmailLabel> {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.color !== undefined) body.color = updates.color;
    return this.request(`/labels/${labelId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Delete a user label.
   */
  async deleteLabel(labelId: string): Promise<void> {
    const token = await this.getValidToken();
    const url = `${GMAIL_API_BASE}/users/me/labels/${labelId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Permanently delete a thread (cannot be undone).
   * Used when deleting from Trash.
   */
  async deleteThread(threadId: string): Promise<void> {
    const token = await this.getValidToken();
    const url = `${GMAIL_API_BASE}/users/me/threads/${threadId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Send an email via Gmail API.
   * Accepts a raw RFC 2822 message encoded as base64url.
   */
  async sendMessage(raw: string, threadId?: string): Promise<GmailMessage> {
    const body: Record<string, string> = { raw };
    if (threadId) body.threadId = threadId;
    return this.request("/messages/send", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Fetch a message attachment's binary data.
   * Returns base64url-encoded data.
   */
  async getAttachment(messageId: string, attachmentId: string): Promise<{ attachmentId: string; size: number; data: string }> {
    return this.request(`/messages/${messageId}/attachments/${attachmentId}`);
  }

}

// Gmail API types
export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messageListVisibility?: "show" | "hide";
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: { textColor: string; backgroundColor: string };
}

export interface GmailThreadStub {
  id: string;
  snippet: string;
  historyId: string;
}

export interface GmailThread {
  id: string;
  historyId: string;
  messages: GmailMessage[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  payload: GmailMessagePart;
  sizeEstimate: number;
}

export interface GmailMessagePart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: GmailHeader[];
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailHistoryItem {
  id: string;
  messages?: GmailMessage[];
  messagesAdded?: { message: GmailMessage }[];
  messagesDeleted?: { message: GmailMessage }[];
  labelsAdded?: { message: GmailMessage; labelIds: string[] }[];
  labelsRemoved?: { message: GmailMessage; labelIds: string[] }[];
}
