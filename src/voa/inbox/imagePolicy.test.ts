const settings = new Map<string, string>();
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  getSecureSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
}));
vi.mock("@/services/db/imageAllowlist", () => ({
  getAllowlistedSenders: vi.fn(async () => new Set(["friend@x.com"])),
}));
vi.mock("@/services/gmail/client", () => ({ GmailClient: class {} }));
let labels: string[] = [];
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(async () => ({ select: async (_sql: string, [, , label = "SPAM"]: unknown[]) => (labels.includes(label as string) ? [{}] : []) })),
}));

import { BLOCK_IMAGES_SETTING, realSource } from "./source";

beforeEach(() => {
  settings.clear();
  labels = [];
});
const k = { accountId: "a", threadId: "t" };

describe("imagePolicy", () => {
  it("loads remote images by default, Velo's old block_remote_images notwithstanding", async () => {
    settings.set("block_remote_images", "true");
    expect((await realSource.imagePolicy(k, ["friend@x.com"])).block).toBe(false);
  });

  it("blocks them, keeping the per-sender allowlist, once Block remote images is on", async () => {
    settings.set(BLOCK_IMAGES_SETTING, "true");
    const policy = await realSource.imagePolicy(k, ["friend@x.com"]);
    expect(policy.block).toBe(true);
    expect(policy.allowed.has("friend@x.com")).toBe(true);
  });

  it("never loads them by itself in spam, allowlisted sender or not", async () => {
    labels = ["SPAM"];
    const policy = await realSource.imagePolicy(k, ["friend@x.com"]);
    expect(policy.block).toBe(true);
    expect(policy.allowed.size).toBe(0);
  });
});
