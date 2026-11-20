import type { DbAccount } from "@/services/db/accounts";

const getAccount = vi.fn();
const insertAccount = vi.fn();
const updateAccountAllTokens = vi.fn();
vi.mock("@/services/db/accounts", () => ({
  getAccount: (...a: unknown[]) => getAccount(...a),
  getAllAccounts: vi.fn(async () => []),
  insertAccount: (...a: unknown[]) => insertAccount(...a),
  updateAccountAllTokens: (...a: unknown[]) => updateAccountAllTokens(...a),
}));
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => "client-id"),
  getSecureSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
}));
const startOAuthFlow = vi.fn();
vi.mock("@/services/gmail/auth", () => ({ startOAuthFlow: (...a: unknown[]) => startOAuthFlow(...a) }));
const syncAccount = vi.fn(async () => {});
vi.mock("@/services/gmail/syncManager", () => ({ syncAccount: (...a: unknown[]) => syncAccount(...a) }));
vi.mock("@/services/gmail/client", () => ({ GmailClient: class {} }));

const reauthorizeGraphAccount = vi.fn(async () => {});
vi.mock("@/services/graph/auth", () => ({
  reauthorizeGraphAccount: (...args: unknown[]) => reauthorizeGraphAccount(...args),
}));

import { realSource } from "./source";

const account = (provider: string) => ({ id: "a1", email: "Me@Example.com", provider }) as DbAccount;

beforeEach(() => {
  vi.clearAllMocks();
  startOAuthFlow.mockResolvedValue({
    tokens: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
    userInfo: { email: "me@example.com" },
  });
});

describe("reconnect", () => {
  it("re-authorizes the existing account in place and syncs it; it never inserts", async () => {
    getAccount.mockResolvedValue(account("gmail_api"));
    await realSource.reconnect("a1");
    expect(updateAccountAllTokens).toHaveBeenCalledWith("a1", "new-access", "new-refresh", expect.any(Number));
    expect(insertAccount).not.toHaveBeenCalled();
    expect(syncAccount).toHaveBeenCalledWith("a1");
  });

  it("refuses a different Google account and changes nothing", async () => {
    getAccount.mockResolvedValue(account("gmail_api"));
    startOAuthFlow.mockResolvedValue({ tokens: { access_token: "x", refresh_token: "y", expires_in: 1 }, userInfo: { email: "other@example.com" } });
    await expect(realSource.reconnect("a1")).rejects.toThrow(/expected Me@Example.com/);
    expect(updateAccountAllTokens).not.toHaveBeenCalled();
    expect(syncAccount).not.toHaveBeenCalled();
  });

  it("does not offer it for IMAP accounts", async () => {
    getAccount.mockResolvedValue(account("imap"));
    await expect(realSource.reconnect("a1")).rejects.toThrow(/Gmail/);
    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("re-authorizes an Outlook account through Microsoft", async () => {
    getAccount.mockResolvedValue(account("graph"));
    await realSource.reconnect("a1");
    expect(reauthorizeGraphAccount).toHaveBeenCalledWith("a1");
    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(syncAccount).toHaveBeenCalledWith("a1");
  });
});
