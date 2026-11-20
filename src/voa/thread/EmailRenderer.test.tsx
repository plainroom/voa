import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailRenderer, MAIL_SANDBOX } from "./EmailRenderer";
import type { DbAttachment } from "@/services/db/attachments";

function frame(container: HTMLElement): HTMLIFrameElement {
  const el = container.querySelector("iframe[data-email]");
  if (!(el instanceof HTMLIFrameElement)) throw new Error("mail iframe missing");
  return el;
}

/** The document the mail's iframe renders, as WebKit will parse it. */
function mail(container: HTMLElement): Document {
  return new DOMParser().parseFromString(frame(container).getAttribute("srcdoc") ?? "", "text/html");
}

// Mock dependencies

vi.mock("@/utils/sanitize", () => ({
  sanitizeHtml: (html: string) => html,
  escapeHtml: (text: string) => text,
}));

vi.mock("@/services/db/imageAllowlist", () => ({
  addToAllowlist: vi.fn(),
}));

const mockFetchAttachment = vi.fn();

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn().mockResolvedValue({
    fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args),
  }),
}));

// Mock ResizeObserver for jsdom; `resizeAll` plays a resize of everything observed.
const observers = new Set<MockResizeObserver>();
class MockResizeObserver {
  constructor(private callback: () => void) {}
  observe() {
    observers.add(this);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this);
  }
  fire() {
    this.callback();
  }
}
const resizeAll = () => observers.forEach((o) => o.fire());
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

function makeAttachment(overrides: Partial<DbAttachment> = {}): DbAttachment {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: "icon.png",
    mime_type: "image/png",
    size: 1024,
    gmail_attachment_id: "gmail-att-1",
    content_id: "icon@example.com",
    is_inline: 1,
    local_path: null,
    ...overrides,
  };
}

describe("EmailRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders plain text when no html provided", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Hello world" />,
    );
    expect(mail(container).body.textContent).toContain("Hello world");
  });

  it("renders html content", () => {
    const { container } = render(
      <EmailRenderer html="<p>Hello</p>" text={null} />,
    );
    expect(mail(container).querySelector("p")?.textContent).toBe("Hello");
  });

  it("opens a link outside the app, as a popup the shell hands to the system", () => {
    const { container } = render(
      <EmailRenderer html='<p><a href="https://example.com/proposal">Open</a></p>' text={null} />,
    );
    const a = mail(container).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/proposal");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  describe("a hostile message", () => {
    // sanitizeHtml is mocked as identity here: isolation must hold even if DOMPurify let these through.
    const hostile = [
      '<div style="position:fixed;inset:0;z-index:2147483647;background:#fff">Your session expired. Sign in again</div>',
      '<img src="https://x.test/map.png" usemap="#m"><map name="m"><area shape="rect" coords="0,0,9999,9999" href="https://phish.test"></map>',
      '<a href="#/settings">Settings</a><area href="#/compose">',
      '<a href="javascript:parent.location=\'https://phish.test\'">Click</a>',
      '<form action="https://phish.test/steal" method="post"><input name="password"><button>Go</button></form>',
      '<a href="https://phish.test" target="_top">top</a>',
      '<script>parent.location.hash = "#/settings"</script>',
    ].join("");

    it("renders in a frame that runs no script, cannot navigate the app and cannot submit forms", () => {
      const { container } = render(<EmailRenderer html={hostile} text={null} />);
      const iframe = frame(container);
      const sandbox = iframe.getAttribute("sandbox")!.split(/\s+/);
      expect(sandbox).toEqual(MAIL_SANDBOX.split(" "));
      for (const forbidden of ["allow-scripts", "allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-forms", "allow-modals"]) {
        expect(sandbox).not.toContain(forbidden);
      }
      // The mail never enters the app's own document, where a fixed overlay would cover the window.
      expect(document.body.textContent).not.toContain("Your session expired");
      expect(document.querySelector("[style*='position:fixed']")).toBeNull();
    });

    it("keeps only http(s) and mailto links, each leaving as a popup", () => {
      const { container } = render(<EmailRenderer html={hostile} text={null} />);
      const doc = mail(container);
      const links = Array.from(doc.querySelectorAll("[href]")).filter((el) => el.tagName !== "LINK");
      expect(links.map((el) => el.getAttribute("href"))).toEqual(["https://phish.test", "https://phish.test"]);
      for (const link of links) expect(link.getAttribute("target")).toBe("_blank");
      expect(doc.querySelectorAll("[target=_top]")).toHaveLength(0);
    });
  });

  it("resolves cid: references by fetching inline attachment data", async () => {
    const base64Data = btoa("fake-image-data");
    mockFetchAttachment.mockResolvedValue({ data: base64Data, size: 100 });

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "gmail-att-1");
    });

    expect(mail(container).querySelector("img")).toBeTruthy();
  });

  it("skips cid resolution when no inline attachments", () => {
    render(
      <EmailRenderer
        html='<img src="cid:missing@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={[]}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("skips cid resolution when accountId or messageId missing", () => {
    const inlineAttachments = [makeAttachment()];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("handles fetch failure gracefully", async () => {
    mockFetchAttachment.mockRejectedValue(new Error("Network error"));

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalled();
    });

    expect(mail(container).querySelector("img")).toBeTruthy();
  });

  it("resolves multiple cid references", async () => {
    mockFetchAttachment
      .mockResolvedValueOnce({ data: btoa("img1"), size: 50 })
      .mockResolvedValueOnce({ data: btoa("img2"), size: 60 });

    const inlineAttachments = [
      makeAttachment({ id: "att-1", content_id: "img1@ex.com", gmail_attachment_id: "g1" }),
      makeAttachment({ id: "att-2", content_id: "img2@ex.com", gmail_attachment_id: "g2", mime_type: "image/jpeg" }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:img1@ex.com" /><img src="cid:img2@ex.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledTimes(2);
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g1");
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g2");
    });
  });

  it("ignores attachments without content_id or gmail_attachment_id", () => {
    const inlineAttachments = [
      makeAttachment({ content_id: null }),
      makeAttachment({ id: "att-2", gmail_attachment_id: null }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  describe("remote images", () => {
    const html = '<p>Hi</p><img src="https://tracker.example.com/pixel.png">';

    it("loads them with no banner unless told to block", () => {
      render(<EmailRenderer html={html} text={null} senderAddress="a@x.com" accountId="acc-1" />);
      expect(screen.queryByText(/Images hidden/)).toBeNull();
      const root = mail(document.body);
      expect(root.querySelector("img")?.getAttribute("src")).toBe("https://tracker.example.com/pixel.png");
    });

    it("hides them behind Load images when blocking, and not for an allowlisted sender", () => {
      const { unmount } = render(<EmailRenderer html={html} text={null} blockImages senderAddress="a@x.com" accountId="acc-1" />);
      expect(screen.getByText(/Images hidden/)).toBeTruthy();
      expect(screen.getByText("Always load from sender")).toBeTruthy();
      unmount();
      render(<EmailRenderer html={html} text={null} blockImages senderAllowlisted senderAddress="a@x.com" accountId="acc-1" />);
      expect(screen.queryByText(/Images hidden/)).toBeNull();
    });
  });

  describe("the frame's height", () => {
    function sized(root: number, body: number) {
      const { container } = render(<EmailRenderer html="<p>Long</p>" text={null} />);
      const iframe = frame(container);
      const doc = iframe.contentDocument!;
      const size = { root, body };
      vi.spyOn(doc.documentElement, "getBoundingClientRect").mockImplementation(() => ({ height: size.root }) as DOMRect);
      Object.defineProperty(doc.body, "scrollHeight", { get: () => size.body });
      fireEvent.load(iframe);
      return { iframe, size };
    }

    it("is the content's, the root's box or the body's, whichever is taller", () => {
      expect(sized(1234.2, 900).iframe.style.height).toBe("1235px");
      expect(sized(100, 640).iframe.style.height).toBe("640px");
    });

    it("is set once the mail is parsed, without waiting for its images to load", async () => {
      const { container } = render(<EmailRenderer html="<p>Long</p>" text={null} />);
      const doc = frame(container).contentDocument!;
      vi.spyOn(doc.documentElement, "getBoundingClientRect").mockImplementation(() => ({ height: 1800 }) as DOMRect);
      Object.defineProperty(doc, "URL", { get: () => "about:srcdoc" });
      Object.defineProperty(doc, "readyState", { get: () => "interactive" });
      await waitFor(() => expect(frame(container).style.height).toBe("1800px"));
    });

    it("says once per mail document that it has its height", () => {
      const onSized = vi.fn();
      const { container } = render(<EmailRenderer html="<p>Long</p>" text={null} onSized={onSized} />);
      const iframe = frame(container);
      fireEvent.load(iframe);
      resizeAll();
      fireEvent.load(iframe);
      expect(onSized).toHaveBeenCalledTimes(1);
    });

    it("follows the content when it resizes, growing or shrinking", () => {
      const { iframe, size } = sized(300, 0);
      size.root = 2400; // an image arrived
      resizeAll();
      expect(iframe.style.height).toBe("2400px");
      size.root = 800; // the window got wider
      resizeAll();
      expect(iframe.style.height).toBe("800px");
    });
  });

  describe("keys after a click in the mail", () => {
    it("a plain key goes back to the app at once, focus with it", () => {
      const { container } = render(<EmailRenderer html="<p>Hi</p>" text={null} />);
      const iframe = frame(container);
      fireEvent.load(iframe);
      iframe.focus();
      const seen: string[] = [];
      const onKey = (e: KeyboardEvent) => seen.push(e.key);
      window.addEventListener("keydown", onKey);
      iframe.contentDocument!.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
      iframe.contentDocument!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }));
      iframe.contentDocument!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
      window.removeEventListener("keydown", onKey);
      expect(seen).toEqual(["e", "z"]);
      expect(document.activeElement).not.toBe(iframe);
    });

    it("returning to the window leaves the mail, so the next key is the app's", () => {
      const { container } = render(<EmailRenderer html="<p>Hi</p>" text={null} />);
      const iframe = frame(container);
      fireEvent.load(iframe);
      iframe.focus();
      window.dispatchEvent(new Event("focus"));
      expect(document.activeElement).toBe(iframe.parentElement);
    });

    it("a link click parks on the reading surface before the app leaves", () => {
      const { container } = render(<EmailRenderer html="<p>Hi</p>" text={null} />);
      const iframe = frame(container);
      fireEvent.load(iframe);
      const doc = iframe.contentDocument!;
      const link = doc.createElement("a");
      link.href = "https://example.com";
      doc.body.appendChild(link);
      link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(document.activeElement).toBe(iframe.parentElement);
    });
  });
});
