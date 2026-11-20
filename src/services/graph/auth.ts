import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getAccount, getAccountByEmail, insertGraphAccount, updateAccountAllTokens } from "../db/accounts";
import { getSetting } from "../db/settings";
import { normalizeEmail } from "@/utils/emailUtils";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { codeChallenge, randomToken } from "../oauth/pkce";
import { MICROSOFT_CALLBACK_PORT, microsoftAuthUrl, microsoftRedirectUri } from "./config";
import { exchangeMicrosoftCode, fetchGraphProfile, type MicrosoftTokens } from "./client";
import { removeGraphClient } from "./tokenManager";

export interface MicrosoftProfile {
  email: string;
  name: string;
}

/** Browser sign-in for a personal Microsoft account. Returns tokens and the mailbox. */
export async function startMicrosoftOAuth(clientId: string): Promise<{ tokens: MicrosoftTokens; profile: MicrosoftProfile }> {
  const id = clientId.trim();
  if (!id) throw new Error("Add the Microsoft client ID in Settings first.");

  const verifier = randomToken();
  const state = randomToken();
  // The server says the port it bound before it waits; the browser is sent back to that one.
  const listening = new Channel<number>();
  const bound = new Promise<number>((resolve) => {
    listening.onmessage = resolve;
  });
  const serverPromise = invoke<{ code: string; state: string }>("start_oauth_server_any_port", {
    port: MICROSOFT_CALLBACK_PORT,
    state,
    onListening: listening,
  });
  // A server that could not bind fails here, at once, instead of leaving the sign-in waiting.
  const redirectUri = microsoftRedirectUri(await Promise.race([bound, serverPromise.then(() => bound)]));
  await openUrl(microsoftAuthUrl(id, state, await codeChallenge(verifier), redirectUri));
  const result = await serverPromise;
  if (result.state !== state) throw new Error("Microsoft sign-in did not match. Try again.");

  const tokens = await exchangeMicrosoftCode(result.code, id, verifier, redirectUri);
  const profile = await fetchGraphProfile(tokens.access_token);
  return { tokens, profile };
}

function requireRefreshToken(tokens: MicrosoftTokens): string {
  if (!tokens.refresh_token) throw new Error("Microsoft did not return a refresh token. Try the sign-in again.");
  return tokens.refresh_token;
}

/** Sign in and store the mailbox. An existing Outlook account is updated. A Gmail or IMAP row is left alone. */
export async function connectGraphAccount(clientId: string): Promise<void> {
  const { tokens, profile } = await startMicrosoftOAuth(clientId);
  const refreshToken = requireRefreshToken(tokens);
  const expiresAt = getCurrentUnixTimestamp() + tokens.expires_in;
  const existing = await getAccountByEmail(profile.email);
  if (existing && existing.provider !== "graph") {
    throw new Error(`${profile.email} is already connected. Remove it before adding it as Outlook.`);
  }
  if (existing) {
    removeGraphClient(existing.id);
    await updateAccountAllTokens(existing.id, tokens.access_token, refreshToken, expiresAt);
    return;
  }
  await insertGraphAccount({
    id: crypto.randomUUID(),
    email: profile.email,
    displayName: profile.name,
    accessToken: tokens.access_token,
    refreshToken,
    tokenExpiresAt: expiresAt,
    oauthClientId: clientId.trim(),
  });
}

/** Sign in again and keep the same mailbox. */
export async function reauthorizeGraphAccount(accountId: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("Account not found");
  const clientId = account.oauth_client_id || (await getSetting("microsoft_client_id")) || "";
  const { tokens, profile } = await startMicrosoftOAuth(clientId);
  if (normalizeEmail(profile.email) !== normalizeEmail(account.email)) {
    throw new Error(`Signed in as ${profile.email}, but this account is ${account.email}.`);
  }
  const refreshToken = requireRefreshToken(tokens);
  await updateAccountAllTokens(accountId, tokens.access_token, refreshToken, getCurrentUnixTimestamp() + tokens.expires_in);
  removeGraphClient(accountId);
}
