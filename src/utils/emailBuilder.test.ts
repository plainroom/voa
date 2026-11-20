import { describe, it, expect } from "vitest";
import { buildRawEmail, encodeHeader } from "./emailBuilder";

describe("emailBuilder", () => {
  it("builds a basic email", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Test Subject",
      htmlBody: "<p>Hello World</p>",
    });

    // Should be base64url encoded
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).not.toContain("=");

    // Decode to verify structure
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("From: sender@example.com");
    expect(decoded).toContain("To: recipient@example.com");
    expect(decoded).toContain("Subject: Test Subject");
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain("<p>Hello World</p>");
  });

  it("includes Date and Message-ID headers", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toMatch(/Date: .+/);
    expect(decoded).toMatch(/Message-ID: <.+@example\.com>/);
  });

  it("includes CC and BCC headers", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("Cc: cc@example.com");
    expect(decoded).toContain("Bcc: bcc@example.com");
  });

  it("includes In-Reply-To header", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Re: Test",
      htmlBody: "<p>Reply</p>",
      inReplyTo: "<msg-id@gmail.com>",
      references: "<msg-id@gmail.com>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("In-Reply-To: <msg-id@gmail.com>");
    expect(decoded).toContain("References: <msg-id@gmail.com>");
  });

  it("generates plain text from HTML", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Test",
      htmlBody: "<p>Hello</p><br><p>World</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });

  it("handles multiple recipients", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("To: a@example.com, b@example.com");
  });

  it("builds email with attachments using multipart/mixed", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "With attachment",
      htmlBody: "<p>See attached</p>",
      attachments: [
        {
          filename: "test.txt",
          mimeType: "text/plain",
          content: btoa("Hello file content"),
        },
      ],
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("multipart/mixed");
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain('Content-Disposition: attachment; filename="test.txt"');
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
    expect(decoded).toContain("<p>See attached</p>");
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });

  it("builds email with multiple attachments", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Multi attach",
      htmlBody: "<p>Files</p>",
      attachments: [
        { filename: "a.txt", mimeType: "text/plain", content: btoa("aaa") },
        { filename: "b.pdf", mimeType: "application/pdf", content: btoa("bbb") },
      ],
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('filename="a.txt"');
    expect(decoded).toContain('filename="b.pdf"');
    expect(decoded).toContain("application/pdf");
  });

  it("keeps multipart/alternative when no attachments", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "No attach",
      htmlBody: "<p>Plain</p>",
      attachments: [],
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).not.toContain("multipart/mixed");
  });
});

function decodeBase64Url(encoded: string): string {
  // Add back padding
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

describe("parseRawEmail", () => {
  it("reads back what buildRawEmail wrote, multi-line HTML and accents included", async () => {
    const { buildRawEmail, parseRawEmail } = await import("./emailBuilder");
    const html = "<p>Olá, tudo bem?</p>\n<p>-- not a boundary</p>";
    const raw = buildRawEmail({ from: "me@x.com", to: ["a@x.com", "b@y.com"], subject: "Reunião amanhã", htmlBody: html });
    expect(parseRawEmail(raw)).toEqual({ to: ["a@x.com", "b@y.com"], cc: [], subject: "Reunião amanhã", html });
  });

  it("keeps Cc apart from To and the threading headers of a reply", async () => {
    const { buildRawEmail, parseRawEmail } = await import("./emailBuilder");
    const raw = buildRawEmail({ from: "me@x.com", to: ["a@x.com"], cc: ["c@x.com"], subject: "Re: Hi", htmlBody: "<p>ok</p>", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" });
    expect(parseRawEmail(raw)).toEqual({ to: ["a@x.com"], cc: ["c@x.com"], subject: "Re: Hi", html: "<p>ok</p>", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" });
  });
});

describe("encodeHeader", () => {
  it("keeps ASCII and writes anything else as UTF-8 words that read back whole", () => {
    expect(encodeHeader("Re: Plan")).toBe("Re: Plan");
    const subject = "Fwd: Relatório Diário SDR - Clara — segunda-feira, 16 de novembro de 2026";
    const encoded = encodeHeader(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    const words = encoded.split("\r\n ");
    expect(words.every((w) => w.length <= 75)).toBe(true);
    const decoded = words.map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).join("");
    expect(decoded).toBe(subject);
  });
});
