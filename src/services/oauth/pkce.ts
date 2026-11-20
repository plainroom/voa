import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Localhost port every fixed-port sign-in listens on. Microsoft may use one of the next three. */
export const OAUTH_CALLBACK_PORT = 17248;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Opens the provider page and waits for the browser to come back to the local port.
 * The caller builds the authorize URL, including its own redirect host.
 */
export async function receiveOAuthRedirect(authUrl: string, state: string, port = OAUTH_CALLBACK_PORT): Promise<string> {
  const serverPromise = invoke<{ code: string; state: string }>("start_oauth_server", { port, state });
  await new Promise((r) => setTimeout(r, 100));
  await openUrl(authUrl);
  const result = await serverPromise;
  if (result.state !== state) {
    throw new Error("OAuth state mismatch: possible CSRF attack. Please try again.");
  }
  return result.code;
}
