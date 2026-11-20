import { describe, it, expect } from "vitest";
import { escapeHtml, sanitizeHtml } from "./sanitize";

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes through safe text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  it("escapes complex XSS payload", () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const result = escapeHtml(payload);
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
    expect(result).toContain("&quot;&gt;");
  });
});

describe("sanitizeHtml", () => {
  it("drops a sender's data attributes, so a blocked image never comes back through the reader's own", () => {
    const out = sanitizeHtml('<img src="" data-web="https://t.example/p.gif" data-blocked-src="https://a.example/b.png">');
    expect(out).not.toContain("data-web");
    expect(out).toContain('data-blocked-src="https://a.example/b.png"');
  });

  it("strips script tags", () => {
    const html = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<script");
    expect(result).toContain("<p>Hello</p>");
  });

  it("strips style tags", () => {
    const html = '<style>body{display:none}</style><p>Content</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<style");
    expect(result).toContain("<p>Content</p>");
  });

  it("strips iframe tags", () => {
    const html = '<iframe src="https://evil.com"></iframe><p>Safe</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<iframe");
    expect(result).toContain("<p>Safe</p>");
  });

  it("strips event handler attributes", () => {
    const html = '<img src="test.jpg" onerror="alert(1)" />';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onerror");
  });

  it("strips onmouseover and other on* attributes", () => {
    const html = '<div onmouseover="alert(1)" onfocus="alert(2)">text</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onmouseover");
    expect(result).not.toContain("onfocus");
  });

  it("preserves allowed attributes", () => {
    const html = '<a href="https://example.com" title="link">Click</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('title="link"');
  });

  it("preserves data-blocked-src attribute", () => {
    const html = '<img data-blocked-src="https://example.com/img.png" src="" />';
    const result = sanitizeHtml(html);
    expect(result).toContain("data-blocked-src");
  });

  it("strips object and embed tags", () => {
    const html = '<object data="evil.swf"></object><embed src="evil.swf" />';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<object");
    expect(result).not.toContain("<embed");
  });

  it("strips form tags", () => {
    const html = '<form action="https://evil.com"><input type="password" /></form>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<form");
  });

  it("preserves basic email HTML structure", () => {
    const html = '<div><p>Hello <strong>World</strong></p><br><a href="https://example.com">Link</a></div>';
    const result = sanitizeHtml(html);
    expect(result).toContain("<p>Hello <strong>World</strong></p>");
    expect(result).toContain("<br>");
    expect(result).toContain('<a href="https://example.com">Link</a>');
  });

  it("handles empty string", () => {
    expect(sanitizeHtml("")).toBe("");
  });
});

describe("sanitizeHtml drops tracking pixels", () => {
  const kept = (img: string) => sanitizeHtml(`<p>Hi</p>${img}`).includes("<img");

  it("drops an image of 1 px or less on a side, by attribute or by style", () => {
    expect(kept('<img src="https://t.example/o.gif" width="1" height="1">')).toBe(false);
    expect(kept('<img src="https://t.example/o.gif" height="0">')).toBe(false);
    expect(kept('<img src="https://t.example/o.gif" style="width:1px;height:1px">')).toBe(false);
  });

  it("drops a hidden image", () => {
    expect(kept('<img src="https://t.example/o.gif" style="display:none!important">')).toBe(false);
    expect(kept('<img src="https://t.example/o.gif" style="visibility:hidden">')).toBe(false);
  });

  it("keeps the images a reader sees, sized or not", () => {
    expect(kept('<img src="https://x.example/banner.png" width="600" height="200">')).toBe(true);
    expect(kept('<img src="https://x.example/banner.png" width="100%">')).toBe(true);
    expect(kept('<img src="https://x.example/logo.png">')).toBe(true);
    expect(kept('<img src="https://x.example/icon.png" style="width:16px">')).toBe(true);
  });
});
