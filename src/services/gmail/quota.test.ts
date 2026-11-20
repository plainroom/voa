import { describe, it, expect } from "vitest";
import { costOf, isRateLimited, QuotaBudget, QUOTA_WINDOW_MS, retryDelayMs } from "./quota";

describe("isRateLimited", () => {
  it("tells Gmail's quota from any other 403", () => {
    const quota = JSON.stringify({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }], status: "PERMISSION_DENIED" } });
    const user = JSON.stringify({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } });
    const details = JSON.stringify({ error: { code: 403, details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } });
    const forbidden = JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } });
    expect(isRateLimited(403, quota)).toBe(true);
    expect(isRateLimited(403, user)).toBe(true);
    expect(isRateLimited(403, details)).toBe(true);
    expect(isRateLimited(403, forbidden)).toBe(false);
    expect(isRateLimited(403, "Forbidden")).toBe(false);
    expect(isRateLimited(429, "")).toBe(true);
    expect(isRateLimited(500, quota)).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("doubles from 1 s to 32 s with at most a quarter of jitter, and honors Retry-After", () => {
    for (const [attempt, base] of [[1, 1000], [2, 2000], [6, 32_000], [9, 32_000]] as const) {
      const ms = retryDelayMs(null, attempt);
      expect(ms).toBeGreaterThanOrEqual(base);
      expect(ms).toBeLessThanOrEqual(base * 1.25);
    }
    expect(retryDelayMs("3", 1)).toBe(3000);
  });
});

describe("costOf", () => {
  it("prices the calls the sync makes", () => {
    expect(costOf("GET", "/threads/abc?format=full")).toBe(10);
    expect(costOf("GET", "/threads?maxResults=100")).toBe(10);
    expect(costOf("GET", "/messages/abc?format=full")).toBe(5);
    expect(costOf("GET", "/history?startHistoryId=1")).toBe(2);
    expect(costOf("GET", "/labels")).toBe(1);
    expect(costOf("POST", "/messages/send")).toBe(100);
  });
});

describe("QuotaBudget", () => {
  function fakeClock() {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("never lets background work spend more than its budget in any minute", async () => {
    const clock = fakeClock();
    const budget = new QuotaBudget(4000, clock);
    const sent: number[] = [];
    // Three workers asking for threads.get (10 units) as fast as they can for a simulated five minutes.
    const worker = async () => {
      while (clock.now() < 5 * QUOTA_WINDOW_MS) {
        await budget.reserve(10);
        sent.push(clock.now());
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const at of sent) {
      const inWindow = sent.filter((t) => t > at - QUOTA_WINDOW_MS && t <= at).length;
      expect(inWindow * 10).toBeLessThanOrEqual(4000);
    }
    expect(sent.length).toBeGreaterThan(4 * 400); // and it does use the budget
  });

  it("counts what was sent at once, so background work leaves it room", async () => {
    const clock = fakeClock();
    const budget = new QuotaBudget(100, clock);
    budget.spend(95); // a user action
    await budget.reserve(10); // waits for the user action to leave the window
    expect(clock.now()).toBeGreaterThanOrEqual(QUOTA_WINDOW_MS);
    expect(budget.used()).toBe(10);
  });

  it("never holds a request sent at once", () => {
    const budget = new QuotaBudget(10, fakeClock());
    budget.spend(10);
    budget.spend(10);
    expect(budget.used()).toBe(20);
  });
});
