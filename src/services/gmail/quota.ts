/**
 * Gmail's per-user quota is 6000 units a minute (`totalQueryCostPerMinutePerUser`), shared by every
 * request of the account. Each request spends its cost here as it is sent; only background work (the
 * first sync's backfill) waits for room, under a lower budget, so what the user does and the delta
 * sync always find quota left and never queue behind it.
 */

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 32_000;

/** Gmail kept refusing a request for the account's quota: nothing is wrong with the account, it is tried again later. */
/** Gmail has no such thread or message: it was deleted there (Spam and Trash empty themselves after 30 days). */
export class GmailNotFoundError extends Error {}

export class GmailRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailRateLimitError";
  }
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);

/**
 * Whether Gmail refused for the quota: a 429, or a 403 whose error says so in `errors[].reason` or
 * `details[].reason`. Any other 403 (no permission, the API disabled) is not.
 */
export function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  let error: { errors?: { reason?: string }[]; details?: { reason?: string }[] } | undefined;
  try {
    error = (JSON.parse(body) as { error?: typeof error }).error;
  } catch {
    return false;
  }
  return [...(error?.errors ?? []), ...(error?.details ?? [])].some((e) => RATE_LIMIT_REASONS.has(e.reason ?? ""));
}

/** Retry-After (seconds or an HTTP date) when Gmail gives one, else 1 s doubling to 32 s, plus up to a quarter of jitter. */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS * 2);
  }
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.random() * base * 0.25;
}

export const QUOTA_WINDOW_MS = 60_000;
/** What background work may use of the account's 6000 a minute, counting everything else sent. */
const BACKGROUND_BUDGET = 4000;

/** Gmail's quota units per method (https://developers.google.com/gmail/api/reference/quota). */
export function costOf(method: string, path: string): number {
  const segments = path
    .split("?")[0]!
    .split("/users/me")
    .pop()!
    .split("/")
    .filter(Boolean);
  const [resource, id, sub] = segments;
  const verb = method.toUpperCase();
  switch (resource) {
    case "profile":
      return 1;
    case "history":
      return 2;
    case "labels":
      return verb === "GET" ? 1 : 5;
    case "threads":
      if (!id) return 10; // list
      if (sub === "modify" || sub === "trash" || sub === "untrash") return 10;
      return verb === "DELETE" ? 20 : 10; // get
    case "messages":
      if (id === "send") return 100;
      if (!id) return 5; // list
      if (sub === "attachments") return 5;
      if (sub === "modify" || sub === "trash" || sub === "untrash") return 5;
      return verb === "DELETE" ? 10 : 5; // get
    case "drafts":
      if (id === "send") return 100;
      if (!id) return verb === "POST" ? 10 : 5; // create, list
      if (verb === "PUT") return 15;
      if (verb === "DELETE") return 10;
      return 5;
    default:
      return 5;
  }
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The units an account spent in the last minute, as a log of what each request cost and when. */
export class QuotaBudget {
  private log: { at: number; cost: number }[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly budget = BACKGROUND_BUDGET,
    private readonly clock: Clock = realClock,
  ) {}

  /** Units spent in the last minute. */
  used(): number {
    const since = this.clock.now() - QUOTA_WINDOW_MS;
    while (this.log.length > 0 && this.log[0]!.at <= since) this.log.shift();
    return this.log.reduce((sum, e) => sum + e.cost, 0);
  }

  /** A request going out now: counted, never held. */
  spend(cost: number): void {
    this.log.push({ at: this.clock.now(), cost });
  }

  /**
   * Waits until the last minute's spending leaves room for `cost` under the budget, then spends it.
   * One caller at a time, in order, so concurrent background requests never overrun it together.
   */
  reserve(cost: number): Promise<void> {
    const turn = this.queue.then(async () => {
      while (this.used() + cost > this.budget && this.log.length > 0) {
        await this.clock.sleep(
          this.log[0]!.at + QUOTA_WINDOW_MS - this.clock.now() + 1,
        );
      }
      this.spend(cost);
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

const budgets = new Map<string, QuotaBudget>();

/** The account's budget, kept across the clients made for it (a token refresh, a reconnect). */
export function quotaFor(accountId: string): QuotaBudget {
  let budget = budgets.get(accountId);
  if (!budget) {
    budget = new QuotaBudget();
    budgets.set(accountId, budget);
  }
  return budget;
}
