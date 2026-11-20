import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("@/services/db/accounts", () => ({ deleteAccount: vi.fn(async () => {}) }));
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (key: string) => (key === "microsoft_client_id" || key.startsWith("ai_") || key === "signature" ? "" : "id-1")),
  getSecureSetting: vi.fn(async () => "secret-1"),
  setSetting: vi.fn(async () => {}),
  setSecureSetting: vi.fn(async () => {}),
}));
vi.mock("@/services/gmail/tokenManager", () => ({ removeClient: vi.fn() }));
vi.mock("@/services/db/blockedSenders", () => ({
  listBlockedSenders: vi.fn(async () => []),
}));

import { deleteAccount } from "@/services/db/accounts";
import { setSecureSetting, setSetting } from "@/services/db/settings";
import { useAccountStore } from "@/stores/accountStore";
import { listBlockedSenders } from "@/services/db/blockedSenders";
import { BLOCK_IMAGES_SETTING, realSource, setDemoSource } from "../inbox/source";
import { getSetting } from "@/services/db/settings";
import { useToastStore } from "../ui/Toast";
import { SettingsScreen } from "./SettingsScreen";

const reconnect = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ current: null, lastUndo: null });
  useAccountStore.setState({
    activeAccountId: "a",
    accounts: [
      { id: "a", email: "me@home.com", displayName: "Home", avatarUrl: null, isActive: true, provider: "gmail_api" },
      { id: "b", email: "me@work.com", displayName: null, avatarUrl: null, isActive: true, provider: "imap" },
      { id: "c", email: "cal@x.com", displayName: null, avatarUrl: null, isActive: true, provider: "caldav" },
    ],
  });
  setDemoSource({ ...realSource, reconnect });
});
afterEach(() => setDemoSource(realSource));

describe("SettingsScreen", () => {
  it("lists the mail accounts and opens the add-account dialog", () => {
    const opened = vi.fn();
    window.addEventListener("voa-add-account", opened);
    render(<SettingsScreen />);
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("me@work.com")).toBeTruthy();
    expect(screen.queryByText("cal@x.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener("voa-add-account", opened);
  });

  it("reconnects Gmail accounts only", async () => {
    render(<SettingsScreen />);
    expect(screen.getAllByRole("button", { name: "Reconnect" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Reconnected"));
  });

  it("removes an account only after confirming", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Remove me@work.com" }));
    expect(screen.getByText(/Its snoozed emails stay archived in Gmail\./)).toBeTruthy();
    expect(deleteAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove me@work.com" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith("b"));
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("saves the Google client and goes back on Esc", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Sign-in clients" }));
    const id = (await screen.findByDisplayValue("id-1")) as HTMLInputElement;
    fireEvent.change(id, { target: { value: " new-id " } });
    fireEvent.click(within(screen.getByRole("region", { name: "Google client" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("google_client_id", "new-id"));
    expect(setSecureSetting).toHaveBeenCalledWith("google_client_secret", "secret-1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("says the Google client was not saved when the write fails", async () => {
    vi.mocked(setSetting).mockRejectedValueOnce(new Error("database is locked"));
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Sign-in clients" }));
    const id = await screen.findByDisplayValue("id-1");
    const save = within(screen.getByRole("region", { name: "Google client" })).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(id, { target: { value: "id-2" } });
    fireEvent.click(save);
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe("Could not save"));
    expect(setSecureSetting).not.toHaveBeenCalled();
  });

  it("saves the Microsoft client id on its own", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Sign-in clients" }));
    const id = await screen.findByLabelText("Microsoft client ID");
    fireEvent.change(id, { target: { value: " app-id " } });
    fireEvent.click(within(screen.getByRole("region", { name: "Microsoft client" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("microsoft_client_id", "app-id"));
    expect(setSecureSetting).not.toHaveBeenCalled();
  });

  it("Block remote images is off by default and saved when turned on", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    const box = screen.getByRole("checkbox", { name: "Block remote images" }) as HTMLInputElement;
    // Loaded: the settings were read.
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith(BLOCK_IMAGES_SETTING));
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith(BLOCK_IMAGES_SETTING, "true"));
    expect(box.checked).toBe(true);
  });

  it("lists a blocked sender and unblocks them", async () => {
    vi.mocked(listBlockedSenders).mockResolvedValueOnce([{ account_id: "a", address: "spam@x.com" }]);
    const unblock = vi.fn(async () => {});
    setDemoSource({ ...realSource, reconnect, unblock });
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked senders" }));
    expect(await screen.findByText("spam@x.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(unblock).toHaveBeenCalledWith("a", "spam@x.com"));
    await waitFor(() => expect(screen.queryByText("spam@x.com")).toBeNull());
  });

  it("shows Block remote images on when it was chosen", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === BLOCK_IMAGES_SETTING ? "true" : key === "microsoft_client_id" ? "" : "id-1"));
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    const box = screen.getByRole("checkbox", { name: "Block remote images" }) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === "microsoft_client_id" ? "" : "id-1"));
  });
  it("saves how to summarize", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    const note = screen.getByRole("textbox", { name: "How to summarize" });
    fireEvent.change(note, { target: { value: " Always summarize in Brazilian Portuguese. " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("ai_note", "Always summarize in Brazilian Portuguese."));
  });
  it("sets the appearance at once and keeps it", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.classList.contains("scheme-dark")).toBe(true);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("appearance", "dark"));
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement.classList.contains("scheme-dark")).toBe(false);
  });
  it("turns a label on and off, keeping the ones turned off", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    const pitch = (await screen.findByRole("checkbox", { name: /pitch/ })) as HTMLInputElement;
    await waitFor(() => expect(pitch.checked).toBe(false));
    fireEvent.click(pitch);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("ai_labels_off", JSON.stringify(["notification"])));
  });
  it("saves the signature, and keeps an emptied one empty", async () => {
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Signature" }));
    const field = await screen.findByDisplayValue("Sent with voa");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("signature", ""));
  });
});
