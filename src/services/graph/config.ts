/**
 * Personal Microsoft accounts. A public desktop client: no secret, and the redirect is http://localhost. Microsoft
 * ignores a localhost redirect's port when it matches one, so the sign-in uses the port it could bind, 17248 first.
 */
const CALLBACK_PORT = 17248;

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
export const MICROSOFT_CALLBACK_PORT = CALLBACK_PORT;

/** The redirect for the port the sign-in's loopback server bound. */
export function microsoftRedirectUri(port: number): string {
  return `http://localhost:${port}`;
}

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export const MICROSOFT_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
].join(" ");

/** Well-known mailbox folders. Graph accepts the name, not a looked-up id. */
export const GRAPH_FOLDER = {
  archive: "archive",
  trash: "deleteditems",
  junk: "junkemail",
  inbox: "inbox",
} as const;

export type GraphFolder = (typeof GRAPH_FOLDER)[keyof typeof GRAPH_FOLDER];

export const GRAPH_MESSAGE_SELECT = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "receivedDateTime",
  "from",
  "toRecipients",
  "ccRecipients",
  "replyTo",
  "isRead",
  "flag",
  "body",
  "internetMessageId",
  "hasAttachments",
].join(",");

/** The browser URL for a personal Microsoft account. */
export function microsoftAuthUrl(clientId: string, state: string, challenge: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    state,
  });
  return `${MICROSOFT_AUTH_URL}?${params.toString()}`;
}
