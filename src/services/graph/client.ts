import { invoke } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { updateAccountAllTokens } from "../db/accounts";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { retryDelayMs } from "../gmail/quota";
import { REVOKED, setSignedOut, SignedOutError } from "../oauth/signedOut";
import { GRAPH_MESSAGE_SELECT, GRAPH_ROOT, MICROSOFT_SCOPES, MICROSOFT_TOKEN_URL } from "./config";
import type { GraphMessage } from "./message";

/** Tries of a request Microsoft throttled (429) or found busy (503) before giving up on this run. */
export const MAX_GRAPH_ATTEMPTS = 4;

/** Microsoft answered with an error. `code` is Graph's `error.code`, when its body says one. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** Microsoft kept throttling or was busy: nothing is wrong with the account, the next sync tries again. */
export class GraphThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphThrottledError";
  }
}

const EXPIRED_CURSOR_CODES = new Set(["syncstatenotfound", "resyncrequired", "syncstateinvalid"]);

/** Microsoft no longer knows the delta cursor (410 Gone, or a sync-state code): the feed starts over. */
export function graphCursorExpired(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false;
  return err.status === 410 || EXPIRED_CURSOR_CODES.has((err.code ?? "").toLowerCase());
}

function graphErrorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MicrosoftTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface GraphProfile {
  email: string;
  name: string;
}

export interface GraphDeltaPage {
  value: GraphMessage[];
  nextLink?: string;
  deltaLink?: string;
}

function profileFromGraph(me: { displayName?: string; mail?: string; userPrincipalName?: string }): GraphProfile {
  const email = me.mail || me.userPrincipalName;
  if (!email) throw new Error("Microsoft did not say which mailbox this is.");
  return { email, name: me.displayName || email };
}

/** Profile from a token that is not in the client cache yet (the sign-in that just finished). */
export async function fetchGraphProfile(accessToken: string): Promise<GraphProfile> {
  const response = await nativeFetch(`${GRAPH_ROOT}/me?$select=displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Could not read the Microsoft account: ${await response.text()}`);
  return profileFromGraph(await response.json());
}

/** `redirectUri` is the one the browser was sent with: Microsoft checks the two are the same. */
export async function exchangeMicrosoftCode(code: string, clientId: string, verifier: string, redirectUri: string): Promise<MicrosoftTokens> {
  try {
    // plugin-http always adds Origin. Microsoft rejects that on a public client (AADSTS90023).
    // This command posts with reqwest and sends no Origin, the same path IMAP already uses.
    return await invoke<MicrosoftTokens>("oauth_exchange_token", {
      tokenUrl: MICROSOFT_TOKEN_URL,
      code,
      clientId,
      redirectUri,
      codeVerifier: verifier,
      clientSecret: null,
      scope: MICROSOFT_SCOPES,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Microsoft sign-in failed: ${detail}`);
  }
}

/** Graph accepts the RFC 822 message as ordinary base64, with padding. */
export function mimeBase64(rawBase64Url: string): string {
  const base = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base.length % 4 === 0 ? "" : "=".repeat(4 - (base.length % 4));
  return base + pad;
}

/**
 * What a search shows in its list, the folder and flags its labels need, and the Message-ID a block records: no body,
 * no recipients.
 */
export const GRAPH_SEARCH_SELECT = "id,conversationId,subject,from,receivedDateTime,bodyPreview,parentFolderId,isRead,flag,internetMessageId";

/** Graph $search wants one quoted KQL string. A quote inside the query is doubled. */
export function graphSearchUrl(query: string, top = 20, select = `${GRAPH_MESSAGE_SELECT},parentFolderId`): string {
  const term = `"${query.trim().replace(/"/g, '""')}"`;
  return `${GRAPH_ROOT}/me/messages?$search=${encodeURIComponent(term)}&$top=${top}&$select=${select}`;
}

export interface GraphFolderRow {
  id: string;
  displayName: string;
  parentFolderId?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  childFolderCount?: number;
  wellKnownName?: string;
}

export interface GraphFile {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string;
  contentBytes?: string;
}

export class GraphClient {
  private readonly folderIds = new Map<string, string>();
  /** The refresh under way, shared: two requests that find the token expiring spend one refresh token, not two. */
  private refreshing: Promise<void> | null = null;

  constructor(
    private accountId: string,
    private clientId: string,
    private accessToken: string,
    private refreshToken: string,
    private expiresAt: number,
  ) {}

  async delta(url?: string): Promise<GraphDeltaPage> {
    const response = await this.send("GET", url ?? `${GRAPH_ROOT}/me/mailFolders/inbox/messages/delta?$top=50`);
    const page = (await response.json()) as {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    return { value: page.value ?? [], nextLink: page["@odata.nextLink"], deltaLink: page["@odata.deltaLink"] };
  }

  /** Flagged mail stays in Starred after it leaves the inbox. A move gives it a new id, so the inbox delta cannot see it. */
  async flagged(): Promise<GraphMessage[]> {
    const found: GraphMessage[] = [];
    let url: string | undefined =
      `${GRAPH_ROOT}/me/messages?$filter=${encodeURIComponent("flag/flagStatus eq 'flagged'")}&$top=50&$select=${GRAPH_MESSAGE_SELECT}`;
    for (let page = 0; page < 10 && url; page++) {
      const response = await this.send("GET", url);
      const data = (await response.json()) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
      found.push(...(data.value ?? []));
      url = data["@odata.nextLink"];
    }
    return found;
  }

  /**
   * Delta pages omit the body. Ask for the messages the list is about to show, 20 at most (Graph's $batch limit).
   * A part Microsoft throttled or failed on its side (429, 5xx) is asked again, after the longest Retry-After the
   * parts give, up to `MAX_GRAPH_ATTEMPTS`. What still has no answer is left out: the caller stores it without a body,
   * and a later sync asks for it again (`messageIdsWithoutBody`). A part Microsoft answers 404 (moved, deleted) is
   * added to `gone`, when given.
   */
  async messages(ids: string[], gone?: Set<string>): Promise<GraphMessage[]> {
    const found: GraphMessage[] = [];
    let pending = ids;
    for (let attempt = 1; pending.length > 0; attempt++) {
      const response = await this.send("POST", `${GRAPH_ROOT}/$batch`, {
        requests: pending.map((id, index) => ({
          id: String(index),
          method: "GET",
          url: `/me/messages/${id}?$select=${GRAPH_MESSAGE_SELECT}`,
        })),
      });
      const data = (await response.json()) as {
        responses?: { id: string; status: number; headers?: Record<string, string>; body: GraphMessage }[];
      };
      const again: string[] = [];
      let retryAfter: string | null = null;
      for (const item of data.responses ?? []) {
        const id = pending[Number(item.id)];
        if (id === undefined) continue;
        if (item.status === 200) {
          found.push(item.body);
        } else if (item.status === 404) {
          gone?.add(id);
        } else if (item.status === 429 || item.status >= 500) {
          again.push(id);
          const wait = Object.entries(item.headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1] ?? null;
          if (wait !== null && (retryAfter === null || Number(wait) > Number(retryAfter))) retryAfter = wait;
        }
      }
      if (again.length === 0 || attempt >= MAX_GRAPH_ATTEMPTS) break;
      await sleep(retryDelayMs(retryAfter, attempt));
      pending = again;
    }
    return found;
  }

  async folderId(wellKnown: string): Promise<string> {
    const cached = this.folderIds.get(wellKnown);
    if (cached) return cached;
    const response = await this.send("GET", `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(wellKnown)}?$select=id`);
    const folder = (await response.json()) as { id?: string };
    if (!folder.id) throw new Error("Outlook did not name that folder");
    this.folderIds.set(wellKnown, folder.id);
    return folder.id;
  }

  /** A folder's newest messages, headers only. `complete` when the folder holds no more than this page. */
  async folderMessages(wellKnown: string, top = 50): Promise<{ value: GraphMessage[]; complete: boolean }> {
    const response = await this.send(
      "GET",
      `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(wellKnown)}/messages?$top=${top}&$orderby=receivedDateTime%20desc&$select=${GRAPH_SEARCH_SELECT}`,
    );
    const data = (await response.json()) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
    return { value: data.value ?? [], complete: !data["@odata.nextLink"] };
  }

  /** One page of matches, headers only (`GRAPH_SEARCH_SELECT`): the body comes when the conversation opens. */
  async search(query: string): Promise<GraphMessage[]> {
    if (!query.trim()) return [];
    const response = await this.send("GET", graphSearchUrl(query, 20, GRAPH_SEARCH_SELECT));
    const data = (await response.json()) as { value?: GraphMessage[] };
    return data.value ?? [];
  }

  /** Every match, one page at a time, following Microsoft's next links until there are none. */
  async *searchPages(query: string): AsyncGenerator<GraphMessage[]> {
    if (!query.trim()) return;
    let url: string | undefined = graphSearchUrl(query, 50);
    while (url) {
      const response = await this.send("GET", url);
      const data = (await response.json()) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
      yield data.value ?? [];
      url = data["@odata.nextLink"];
    }
  }

  async attachments(messageId: string): Promise<GraphFile[]> {
    const response = await this.send(
      "GET",
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/attachments?$top=50`,
    );
    const data = (await response.json()) as { value?: GraphFile[] };
    return (data.value ?? []).filter((file) => !!file.id);
  }

  async attachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
    const response = await this.send(
      "GET",
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const file = (await response.json()) as GraphFile;
    if (file.contentBytes) return { data: file.contentBytes, size: file.size ?? 0 };
    const raw = await this.send(
      "GET",
      `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    );
    const bytes = new Uint8Array(await raw.arrayBuffer());
    return { data: bytesToBase64(bytes), size: bytes.byteLength };
  }

  async folders(): Promise<GraphFolderRow[]> {
    const select = "id,displayName,parentFolderId,totalItemCount,unreadItemCount,childFolderCount,wellKnownName";
    const response = await this.send("GET", `${GRAPH_ROOT}/me/mailFolders?$top=100&$select=${select}`);
    const data = (await response.json()) as { value?: GraphFolderRow[] };
    const top = data.value ?? [];
    const nested = await Promise.all(
      top
        .filter((folder) => (folder.childFolderCount ?? 0) > 0)
        .map(async (folder) => {
          const child = await this.send(
            "GET",
            `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$top=100&$select=${select}`,
          );
          const page = (await child.json()) as { value?: GraphFolderRow[] };
          return page.value ?? [];
        }),
    );
    return [...top, ...nested.flat()];
  }

  async createFolder(name: string, parentId?: string): Promise<GraphFolderRow> {
    const url = parentId
      ? `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(parentId)}/childFolders`
      : `${GRAPH_ROOT}/me/mailFolders`;
    const response = await this.send("POST", url, { displayName: name });
    return (await response.json()) as GraphFolderRow;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.send("PATCH", `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(id)}`, { displayName: name });
  }

  async deleteFolder(id: string): Promise<void> {
    await this.send("DELETE", `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(id)}`);
  }

  async rawMessage(messageId: string): Promise<string> {
    const response = await this.send("GET", `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/$value`);
    return response.text();
  }

  async move(messageId: string, destination: string): Promise<string | null> {
    const response = await this.send("POST", `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}/move`, {
      destinationId: destination,
    });
    try {
      const moved = (await response.json()) as { id?: string };
      return moved.id ?? null;
    } catch {
      return null;
    }
  }

  async patch(messageId: string, body: { isRead?: boolean; flag?: { flagStatus: string } }): Promise<void> {
    await this.send("PATCH", `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}`, body);
  }

  async remove(messageId: string): Promise<void> {
    await this.send("DELETE", `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}`);
  }

  async sendMail(rawBase64Url: string): Promise<void> {
    await this.send("POST", `${GRAPH_ROOT}/me/sendMail`, mimeBase64(rawBase64Url), "text/plain");
  }

  async profile(): Promise<GraphProfile> {
    const response = await this.send("GET", `${GRAPH_ROOT}/me?$select=displayName,mail,userPrincipalName`);
    return profileFromGraph(await response.json());
  }

  /**
   * One request, tried again while Microsoft throttles it (429) or, for a request safe to repeat, is busy (503):
   * after the Retry-After it gives, or 1 s doubling. A 429 was never carried out, so any request may repeat it; a
   * POST that got a 503 may have been (a send), and only `$batch`, whose parts only read, is repeated then.
   * Gives up with a `GraphThrottledError` after `MAX_GRAPH_ATTEMPTS`; any other failure is a `GraphError` at once.
   */
  private async send(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    const repeatable = method !== "POST" || url === `${GRAPH_ROOT}/$batch`;
    for (let attempt = 1; ; attempt++) {
      const response = await nativeFetch(url, {
        method,
        headers: {
          Authorization: await this.authorization(),
          ...(body === undefined ? {} : { "Content-Type": contentType }),
        },
        body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : String(body),
      });
      if (response.status === 404 && method === "DELETE") return response;
      if (response.ok) return response;
      const text = await response.text();
      const message = `Microsoft Graph ${method} failed (${response.status}): ${text}`;
      const throttled = response.status === 429 || (response.status === 503 && repeatable);
      if (!throttled) throw new GraphError(response.status, graphErrorCode(text), message);
      if (attempt >= MAX_GRAPH_ATTEMPTS) throw new GraphThrottledError(message);
      await sleep(retryDelayMs(response.headers.get("Retry-After"), attempt));
    }
  }

  private async authorization(): Promise<string> {
    if (this.expiresAt <= getCurrentUnixTimestamp() + 60) {
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = null;
      });
      await this.refreshing;
    }
    return `Bearer ${this.accessToken}`;
  }

  private async refresh(): Promise<void> {
    try {
      const tokens = await invoke<MicrosoftTokens>("oauth_refresh_token", {
        tokenUrl: MICROSOFT_TOKEN_URL,
        refreshToken: this.refreshToken,
        clientId: this.clientId,
        clientSecret: null,
        scope: MICROSOFT_SCOPES,
      });
      this.accessToken = tokens.access_token;
      if (tokens.refresh_token) this.refreshToken = tokens.refresh_token;
      this.expiresAt = getCurrentUnixTimestamp() + tokens.expires_in;
      await updateAccountAllTokens(this.accountId, this.accessToken, this.refreshToken, this.expiresAt);
      setSignedOut(this.accountId, false);
    } catch (err) {
      if (err === REVOKED) {
        setSignedOut(this.accountId, true);
        throw new SignedOutError("Microsoft");
      }
      throw new Error(`Microsoft sign-in refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
