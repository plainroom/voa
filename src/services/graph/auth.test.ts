import { beforeEach, expect, it, vi } from "vitest";

const { invoke, openUrl, fetch } = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn(async () => {}), fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...args: unknown[]) => openUrl(...(args as [])) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => fetch(...args) }));

import { startMicrosoftOAuth } from "./auth";

beforeEach(() => {
  invoke.mockReset();
  openUrl.mockClear();
  fetch.mockReset();
  fetch.mockResolvedValue(new Response(JSON.stringify({ displayName: "Me", mail: "me@hotmail.com" })));
});

it("sends the browser back to the port the server bound, and redeems the code with that same redirect", async () => {
  invoke.mockImplementation(async (command: string, args: { state: string; onListening: { onmessage: (port: number) => void } }) => {
    if (command === "start_oauth_server_any_port") {
      args.onListening.onmessage(17250);
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
      return { code: "the-code", state: args.state };
    }
    return { access_token: "a", refresh_token: "r", expires_in: 3600 };
  });

  const { profile } = await startMicrosoftOAuth("app-id");

  const url = new URL(openUrl.mock.calls[0]![0] as string);
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:17250");
  expect(invoke).toHaveBeenCalledWith("oauth_exchange_token", expect.objectContaining({ redirectUri: "http://localhost:17250" }));
  expect(profile.email).toBe("me@hotmail.com");
});

it("fails at once, without opening the browser, when no port could be bound", async () => {
  invoke.mockRejectedValue("Port 17248 is in use by another app, so voa cannot receive the sign-in. Close that app and try again.");

  await expect(startMicrosoftOAuth("app-id")).rejects.toMatch("in use by another app");

  expect(openUrl).not.toHaveBeenCalled();
});
