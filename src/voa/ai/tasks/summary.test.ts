import { describe, expect, it } from "vitest";
import type { DbMessage } from "@/services/db/messages";
import { checkSummary, conversation } from "./summary";

describe("checkSummary", () => {
  it("keeps the gist, at most five points, and the action only when the mail asks something", () => {
    const s = checkSummary({ gist: " A trip ", points: ["a", "b", "c", "d", "e", "f", ""], asks: false, action: "Nothing to do" });
    expect(s).toEqual({ gist: "A trip", points: ["a", "b", "c", "d", "e"], action: "" });
    expect(checkSummary({ gist: "Hotel", points: [], asks: true, action: "Send the plate" })?.action).toBe("Send the plate");
  });

  it("shows nothing for an empty or broken answer", () => {
    expect(checkSummary({ gist: "", points: [] })).toBeNull();
    expect(checkSummary("text")).toBeNull();
  });
});

it("reads a conversation oldest first, under who wrote each message, without what a reply quotes", () => {
  const m = (id: string, from: string, html: string) =>
    ({ id, account_id: "a", thread_id: "t", from_name: from, from_address: null, body_html: html, body_text: null }) as unknown as DbMessage;
  const s = conversation([
    m("1", "Hotel", "<p>Send your plate.</p>"),
    m("2", "Vagner", '<p>ABC-1234</p><div class="gmail_quote"><p>Send your plate.</p></div>'),
  ]);
  expect(s.id).toBe("2");
  expect(s.read().text).toBe("Hotel: Send your plate.\n\nVagner: ABC-1234");
});
