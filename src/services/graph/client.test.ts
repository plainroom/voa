import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, fetch, updateAccountAllTokens } = vi.hoisted(() => ({
  invoke: vi.fn(),
  fetch: vi.fn(),
  updateAccountAllTokens: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => fetch(...args) }));
vi.mock("../db/accounts", () => ({ updateAccountAllTokens }));

import { REVOKED, SignedOutError, useSignedOut } from "../oauth/signedOut";
import { GraphClient, GraphError, GraphThrottledError, MAX_GRAPH_ATTEMPTS } from "./client";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A client whose token expired a minute ago. */
const expired = () => new GraphClient("acc", "app-id", "old-access", "old-refresh", Math.floor(Date.now() / 1000) - 60);
const fresh = () => new GraphClient("acc", "app-id", "access", "refresh", Math.floor(Date.now() / 1000) + 3600);

beforeEach(() => {
  invoke.mockReset();
  fetch.mockReset();
  updateAccountAllTokens.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("token refresh", () => {
  it("refreshes once for requests that find the token expiring together", async () => {
    let finish: (tokens: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    fetch.mockImplementation(async () => json(200, { id: "inbox-id" }));
    const client = expired();

    const both = Promise.all([client.folderId("inbox"), client.folderId("archive")]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    finish({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    await both;

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(updateAccountAllTokens).toHaveBeenCalledTimes(1);
    for (const [, init] of fetch.mock.calls) expect(init.headers.Authorization).toBe("Bearer new-access");
  });

  it("tries a refresh again after one failed", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    invoke.mockResolvedValueOnce({ access_token: "new-access", expires_in: 3600 });
    fetch.mockImplementation(async () => json(200, { id: "inbox-id" }));
    const client = expired();

    // Offline is no expired sign-in: nothing asks to reconnect.
    await expect(client.folderId("inbox")).rejects.toThrow("Microsoft sign-in refresh failed");
    expect(useSignedOut.getState().ids.size).toBe(0);
    await expect(client.folderId("inbox")).resolves.toBe("inbox-id");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("marks the account signed out when Microsoft refuses the sign-in, until a refresh works", async () => {
    invoke.mockRejectedValueOnce(REVOKED);
    invoke.mockResolvedValueOnce({ access_token: "new-access", expires_in: 3600 });
    fetch.mockImplementation(async () => json(200, { id: "inbox-id" }));
    const client = expired();

    await expect(client.folderId("inbox")).rejects.toThrow(SignedOutError);
    expect(useSignedOut.getState().ids.size).toBe(1);
    await expect(client.folderId("inbox")).resolves.toBe("inbox-id");
    expect(useSignedOut.getState().ids.size).toBe(0);
  });
});

describe("throttling", () => {
  it("waits the Retry-After Microsoft gives, then tries again", async () => {
    vi.useFakeTimers();
    fetch
      .mockResolvedValueOnce(json(429, { error: { code: "TooManyRequests" } }, { "Retry-After": "7" }))
      .mockResolvedValueOnce(json(200, { id: "inbox-id" }));

    const result = fresh().folderId("inbox");
    await vi.advanceTimersByTimeAsync(6_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBe("inbox-id");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last try with GraphThrottledError, which is no account error", async () => {
    vi.useFakeTimers();
    fetch.mockImplementation(async () => json(503, {}, { "Retry-After": "1" }));

    const result = fresh().folderId("inbox").catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toBeInstanceOf(GraphThrottledError);
    expect(fetch).toHaveBeenCalledTimes(MAX_GRAPH_ATTEMPTS);
  });

  it("never repeats a send Microsoft answered 503: it may have gone", async () => {
    fetch.mockResolvedValue(json(503, {}));

    const error = await fresh().sendMail("YQ").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails any other error at once, with Graph's code", async () => {
    fetch.mockResolvedValue(json(410, { error: { code: "syncStateNotFound" } }));

    const error = await fresh().delta("https://graph/delta").catch((err: unknown) => err);

    expect(error).toMatchObject({ status: 410, code: "syncStateNotFound" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("messages", () => {
  const part = (id: string, status: number, body: unknown = {}, headers?: Record<string, string>) => ({ id, status, body, headers });
  const sentIds = (call: number) =>
    (JSON.parse(fetch.mock.calls[call]![1].body as string) as { requests: { url: string }[] }).requests.map((r) => r.url.split("/")[3]!.split("?")[0]);

  it("asks again for the parts Microsoft throttled, after their Retry-After", async () => {
    vi.useFakeTimers();
    fetch
      .mockResolvedValueOnce(
        json(200, { responses: [part("0", 200, { id: "a" }), part("1", 429, {}, { "Retry-After": "3" }), part("2", 503)] }),
      )
      .mockResolvedValueOnce(json(200, { responses: [part("0", 200, { id: "b" }), part("1", 200, { id: "c" })] }));

    const result = fresh().messages(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);

    expect((await result).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(sentIds(1)).toEqual(["b", "c"]);
  });

  it("leaves out what is still failing after the last try, and never asks again for a part that is gone", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValueOnce(json(200, { responses: [part("0", 200, { id: "a" }), part("1", 404), part("2", 500)] }));
    fetch.mockImplementation(async () => json(200, { responses: [part("0", 500)] }));

    const result = fresh().messages(["a", "gone", "broken"]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect((await result).map((m) => m.id)).toEqual(["a"]);
    expect(fetch).toHaveBeenCalledTimes(MAX_GRAPH_ATTEMPTS);
    expect(sentIds(1)).toEqual(["broken"]);
  });

  it("names the parts Microsoft no longer has", async () => {
    fetch.mockResolvedValueOnce(json(200, { responses: [part("0", 404), part("1", 200, { id: "b" })] }));
    const gone = new Set<string>();

    expect((await fresh().messages(["a", "b"], gone)).map((m) => m.id)).toEqual(["b"]);
    expect([...gone]).toEqual(["a"]);
  });
});
