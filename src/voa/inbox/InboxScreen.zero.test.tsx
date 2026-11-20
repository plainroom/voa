import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatabaseSync } from "node:sqlite";

vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { getDb } from "@/services/db/connection";
import { useUIStore } from "@/stores/uiStore";
import { useVoaStore } from "@/stores/list";
import { useToastStore } from "../ui/Toast";
import { InboxScreen } from "./InboxScreen";
import { asDb, createInboxDb, findSelectedRow, seed } from "./inboxDb.test-helper";

vi.mock("@/services/emailActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/emailActions")>()),
  // As the real one: the local copy leaves the inbox before the provider is asked.
  archiveThread: vi.fn(async (accountId: string, threadId: string) => {
    sqlite.prepare("DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'INBOX'").run(accountId, threadId);
    return { success: true };
  }),
}));

let sqlite: DatabaseSync;

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  sqlite = await createInboxDb();
  vi.mocked(getDb).mockResolvedValue(asDb(sqlite));
  useToastStore.setState({ current: null, lastUndo: null });
  useVoaStore.setState({ filter: null, selected: null, list: "INBOX", pile: "mail", hidden: new Set() });
  useUIStore.setState({ syncErrors: {}, syncingAccounts: [], isOnline: true });
});

describe("InboxScreen when the inbox is empty", () => {
  it("archiving the last email shows the photo", async () => {
    seed(sqlite, "a", "t1", 100, ["INBOX"]);
    seed(sqlite, "a", "t2", 50, ["STARRED"]);
    const { container } = render(<InboxScreen list="INBOX" />);
    await findSelectedRow("S t1");
    fireEvent.keyDown(window, { key: "e" });
    await screen.findByText("All clear.");
    expect(container.querySelector("img")).not.toBeNull();
    await screen.findByText(/1 starred to follow up/);
  });

  it("a failed sync keeps the photo and writes nothing on the bar", async () => {
    useUIStore.setState({ syncErrors: { b: "Authentication expired" } });
    seed(sqlite, "a", "t9", 50, ["SENT"]);
    const { container } = render(<InboxScreen list="INBOX" />);
    await screen.findByText("All clear.");
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByText(/is not syncing/)).toBeNull();
  });

  it("filtered to a clear account while another has mail: a quiet line", async () => {
    seed(sqlite, "b", "t1", 100, ["INBOX"]);
    useVoaStore.setState({ filter: "a" });
    const { container } = render(<InboxScreen list="INBOX" />);
    await screen.findByText("me@home.com is clear");
    expect(container.querySelector("img")).toBeNull();
    await waitFor(() => expect(screen.queryByText("All clear.")).toBeNull());
  });

  it("a first sync keeps the photo and writes nothing on the bar", async () => {
    sqlite.exec("UPDATE accounts SET history_id = NULL WHERE id = 'b'");
    seed(sqlite, "a", "t9", 50, ["SENT"]);
    const { container } = render(<InboxScreen list="INBOX" />);
    await screen.findByText("All clear.");
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByText("Syncing")).toBeNull();
  });

  it("the top bar stays over the photo", async () => {
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("All clear.");
    expect(screen.getByRole("button", { name: /Compose/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Search/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /me@home.com/ })).toBeTruthy();
  });

  it("offline shows the mail already stored, with a quiet Offline, not the reconnect screen", async () => {
    useUIStore.setState({ isOnline: false, syncErrors: { a: "Failed to fetch" } });
    seed(sqlite, "a", "t1", 100, ["INBOX"]);
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("S t1");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText(/is not syncing/)).toBeNull();
  });

  it("offline with an empty local inbox stays All clear, and still says Offline", async () => {
    useUIStore.setState({ isOnline: false, syncErrors: { a: "Failed to fetch" } });
    render(<InboxScreen list="INBOX" />);
    await screen.findByText("All clear.");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText(/is not syncing/)).toBeNull();
  });

});
