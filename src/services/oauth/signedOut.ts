import { create } from "zustand";

/** OAuth's answer for a sign-in the provider no longer honours (RFC 6749 §5.2: expired, revoked, password changed). */
export const REVOKED = "invalid_grant";

/** Whether a token endpoint's error body is that answer. */
export function revoked(body: string): boolean {
  try {
    return (JSON.parse(body) as { error?: unknown }).error === REVOKED;
  } catch {
    return false;
  }
}

/** The provider signed the account out: only a new sign-in (Reconnect) brings it back, so nothing retries it. */
export class SignedOutError extends Error {
  constructor(provider: string) {
    super(`${provider} signed this account out. Reconnect it.`);
    this.name = "SignedOutError";
  }
}

/** The accounts their provider signed out, until a refresh or a reconnect works again. */
export const useSignedOut = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

export function setSignedOut(accountId: string, out: boolean): void {
  const { ids } = useSignedOut.getState();
  if (ids.has(accountId) === out) return;
  const next = new Set(ids);
  if (out) next.add(accountId);
  else next.delete(accountId);
  useSignedOut.setState({ ids: next });
}
