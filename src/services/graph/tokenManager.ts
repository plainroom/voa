import { getAccount } from "../db/accounts";
import { getSetting } from "../db/settings";
import { GraphClient } from "./client";

const clients = new Map<string, Promise<GraphClient>>();

/**
 * The Outlook session for this account. Built from the tokens stored at sign-in, once: callers that ask together
 * share one client, so they share its token refresh too.
 */
export function getGraphClient(accountId: string): Promise<GraphClient> {
  let client = clients.get(accountId);
  if (!client) {
    client = buildClient(accountId);
    clients.set(accountId, client);
    client.catch(() => {
      if (clients.get(accountId) === client) clients.delete(accountId);
    });
  }
  return client;
}

async function buildClient(accountId: string): Promise<GraphClient> {
  const account = await getAccount(accountId);
  if (!account?.access_token || !account.refresh_token) throw new Error("This Outlook account has no sign-in.");
  const clientId = account.oauth_client_id || (await getSetting("microsoft_client_id"));
  if (!clientId) throw new Error("Add the Microsoft client ID in Settings first.");
  return new GraphClient(accountId, clientId, account.access_token, account.refresh_token, account.token_expires_at ?? 0);
}

/** Drop the cached session so the next action reads the tokens just saved. */
export function removeGraphClient(accountId: string): void {
  clients.delete(accountId);
}
