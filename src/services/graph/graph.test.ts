import { describe, expect, it } from "vitest";
import { microsoftAuthUrl } from "./config";
import { GRAPH_SEARCH_SELECT, graphSearchUrl, mimeBase64 } from "./client";
import { toStoredMessage, type GraphMessage } from "./message";

describe("microsoftAuthUrl", () => {
  it("asks the personal-account endpoint for a public client", () => {
    const url = new URL(microsoftAuthUrl("app-id", "state-1", "challenge-1", "http://localhost:17248"));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("app-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:17248");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.searchParams.get("scope")).toContain("https://graph.microsoft.com/Mail.ReadWrite");
    expect(url.searchParams.get("scope")).toContain("https://graph.microsoft.com/Mail.Send");
  });
});

describe("toStoredMessage", () => {
  const message: GraphMessage = {
    id: "m1",
    conversationId: "c1",
    subject: "Hello",
    bodyPreview: "Hi",
    receivedDateTime: "2026-11-15T12:00:00Z",
    from: { emailAddress: { name: "Ana", address: "ana@hotmail.com" } },
    toRecipients: [{ emailAddress: { name: "Me", address: "me@hotmail.com" } }],
    isRead: false,
    flag: { flagStatus: "flagged" },
    body: { contentType: "html", content: "<p>Hi</p>" },
    internetMessageId: "<m1@hotmail.com>",
  };

  it("keeps the conversation as the thread, the flag as a star, and html as html", () => {
    const stored = toStoredMessage("acc", message);
    expect(stored.threadId).toBe("c1");
    expect(stored.isStarred).toBe(true);
    expect(stored.isRead).toBe(false);
    expect(stored.bodyHtml).toBe("<p>Hi</p>");
    expect(stored.bodyText).toBeNull();
    expect(stored.fromAddress).toBe("ana@hotmail.com");
    expect(stored.toAddresses).toBe("Me <me@hotmail.com>");
    expect(stored.date).toBe(Date.parse("2026-11-15T12:00:00Z"));
    expect(stored.messageIdHeader).toBe("<m1@hotmail.com>");
  });
});

describe("graphSearchUrl", () => {
  it("quotes the query so a quote in it cannot break the search", () => {
    const url = new URL(graphSearchUrl('say "hi"'));
    expect(url.searchParams.get("$search")).toBe('"say ""hi"""');
    expect(url.searchParams.get("$select")).toContain("parentFolderId");
  });

  it("the light search asks for headers and preview, never the body", () => {
    const select = new URL(graphSearchUrl("hi", 20, GRAPH_SEARCH_SELECT)).searchParams.get("$select")!.split(",");
    expect(select).toEqual(expect.arrayContaining(["id", "conversationId", "subject", "from", "receivedDateTime", "bodyPreview"]));
    expect(select).not.toContain("body");
  });

  it("the light search asks for the Message-ID, so blocking a hit never opened still records it", () => {
    const select = new URL(graphSearchUrl("hi", 20, GRAPH_SEARCH_SELECT)).searchParams.get("$select")!.split(",");
    expect(select).toContain("internetMessageId");
  });
});

describe("mimeBase64", () => {
  it("turns the app's base64url into the padded base64 Graph wants", () => {
    expect(mimeBase64("YQ")).toBe("YQ==");
    expect(mimeBase64("ab-c")).toBe("ab+c");
  });
});
