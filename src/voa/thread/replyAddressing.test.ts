import type { DbMessage } from "@/services/db/messages";
import { forwardedHtml, replyRecipients, replyThreading, splitAddresses, toBase64 } from "./replyAddressing";

const msg = (m: Partial<DbMessage>): DbMessage =>
  ({ id: "gmail-internal-id", from_address: "ana@x.com", reply_to: null, to_addresses: "me@x.com", cc_addresses: null, ...m }) as DbMessage;

describe("replyRecipients", () => {
  it("replies to the sender", () => {
    expect(replyRecipients("reply", msg({}), "me@x.com")).toEqual({ to: ["ana@x.com"], cc: [] });
  });

  it("replying to the owner's own message goes to that message's To", () => {
    const mine = msg({ from_address: "Me@x.com", to_addresses: "Bob <bob@y.com>, carol@z.com" });
    expect(replyRecipients("reply", mine, "me@x.com").to).toEqual(["Bob <bob@y.com>", "carol@z.com"]);
  });

  it("reply all to the owner's own message keeps its To and Cc, never the owner", () => {
    const mine = msg({ from_address: "me@x.com", to_addresses: "bob@y.com, Me <me@x.com>", cc_addresses: "dan@z.com" });
    expect(replyRecipients("replyAll", mine, "me@x.com")).toEqual({ to: ["bob@y.com"], cc: ["dan@z.com"] });
  });

  it("a note to self goes back to the owner", () => {
    expect(replyRecipients("reply", msg({ from_address: "me@x.com", to_addresses: "me@x.com" }), "me@x.com").to).toEqual(["me@x.com"]);
  });

  it("reply all drops the owner written with a name", () => {
    const m = msg({ to_addresses: "Me <me@x.com>, bob@y.com", cc_addresses: "\"Doe, J\" <j@z.com>, me@x.com" });
    expect(replyRecipients("replyAll", m, "me@x.com")).toEqual({ to: ["ana@x.com", "bob@y.com"], cc: ['"Doe, J" <j@z.com>'] });
  });
});

describe("splitAddresses", () => {
  it("keeps a quoted name with a comma whole", () => {
    expect(splitAddresses('"Doe, J" <j@z.com>, a@b.com')).toEqual(['"Doe, J" <j@z.com>', "a@b.com"]);
  });
});

describe("replyThreading", () => {
  it("uses the RFC Message-ID and appends it to References", () => {
    expect(replyThreading("<abc@mail.gmail.com>", "<root@x>")).toEqual({ inReplyTo: "<abc@mail.gmail.com>", references: "<root@x> <abc@mail.gmail.com>" });
  });
  it("without a Message-ID it sets neither (never Gmail's internal id)", () => {
    expect(replyThreading(null, "<root@x>")).toEqual({});
  });
});

describe("forward", () => {
  it("carries the forwarded message's header and body under the owner's words", () => {
    const html = forwardedHtml(msg({ from_name: "Ana <x>", from_address: "ana@x.com", subject: "Plan", date: Date.UTC(2026, 10, 16), body_html: "<p>body</p>" }));
    expect(html).toContain("---------- Forwarded message ---------");
    expect(html).toContain("From: Ana &lt;x&gt; &lt;ana@x.com&gt;");
    expect(html).toContain("Subject: Plan");
    expect(html.endsWith("<p>body</p>")).toBe(true);
    expect(forwardedHtml(msg({ body_html: null, body_text: "a < b" }))).toContain("<pre>a &lt; b</pre>");
  });

  it("turns an attachment's url-safe base64 into the plain kind", () => {
    expect(toBase64("a-b_cd")).toBe("a+b/cd==");
    expect(toBase64("abcd")).toBe("abcd");
  });
});
