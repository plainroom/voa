const invoke = vi.fn(async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { exchangeMicrosoftCode } from "./client";

it("redeems the Microsoft code without a browser Origin", async () => {
  await exchangeMicrosoftCode("the-code", "app-id", "verifier", "http://localhost:17248");
  expect(invoke).toHaveBeenCalledWith("oauth_exchange_token", {
    tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    code: "the-code",
    clientId: "app-id",
    redirectUri: "http://localhost:17248",
    codeVerifier: "verifier",
    clientSecret: null,
    scope: expect.stringContaining("https://graph.microsoft.com/Mail.ReadWrite"),
  });
});
