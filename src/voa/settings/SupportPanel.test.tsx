import { fireEvent, render, screen } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
const openUrl = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

import { clearDraft, peekDraft } from "../compose/draftStash";
import {
  BUG_URL,
  openSponsors,
  SPONSORS_URL,
  SUPPORT_EMAIL,
  SupportPanel,
} from "./SupportPanel";

beforeEach(() => {
  navigate.mockClear();
  openUrl.mockClear();
  clearDraft();
});

describe("Settings › Support", () => {
  it("a bug report opens its GitHub issue template, outside the app", () => {
    render(<SupportPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    expect(openUrl).toHaveBeenCalledWith(BUG_URL);
    expect(BUG_URL).toBe(
      "https://github.com/plainroom/voa/issues/new?template=bug_report.yml",
    );
    expect(peekDraft()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("feedback and contact open compose to the team, feedback with its subject", () => {
    render(<SupportPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(peekDraft()?.subject).toBe("voa feedback");
    fireEvent.click(screen.getByRole("button", { name: "Contact us" }));
    expect(peekDraft()).toEqual({
      accountId: null,
      to: [SUPPORT_EMAIL],
      subject: "",
      html: "",
    });
  });

  it("Buy me a coffee (the sidebar) opens GitHub Sponsors outside the app", () => {
    openSponsors();
    expect(openUrl).toHaveBeenCalledWith(SPONSORS_URL);
    expect(navigate).not.toHaveBeenCalled();
  });
});
