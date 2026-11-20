import { describe, it, expect } from "vitest";
import { appImage, stripRemoteImages, restoreRemoteImages, hasBlockedImages, throughApp } from "./imageBlocker";

describe("stripRemoteImages", () => {
  it("blocks remote http images", () => {
    const html = '<img src="http://tracker.example.com/pixel.gif" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="http://tracker.example.com/pixel.gif"');
    // The original src should be replaced with empty string
    expect(result).toContain('src=""');
    // Make sure original src= with URL is gone (not counting the data-blocked-src)
    expect(result.replace(/data-blocked-src="[^"]*"/g, "")).not.toContain('src="http://');
  });

  it("blocks remote https images", () => {
    const html = '<img src="https://cdn.example.com/image.png" alt="photo" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="https://cdn.example.com/image.png"');
  });

  it("preserves data: URIs", () => {
    const html = '<img src="data:image/png;base64,iVBOR..." />';
    const result = stripRemoteImages(html);
    expect(result).toBe(html);
  });

  it("preserves cid: URIs", () => {
    const html = '<img src="cid:image001@example.com" />';
    const result = stripRemoteImages(html);
    expect(result).toBe(html);
  });

  it("handles multiple images", () => {
    const html = '<img src="https://a.com/1.png" /><img src="https://b.com/2.png" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="https://a.com/1.png"');
    expect(result).toContain('data-blocked-src="https://b.com/2.png"');
  });

  it("handles single-quoted src", () => {
    const html = "<img src='https://cdn.example.com/img.jpg' />";
    const result = stripRemoteImages(html);
    expect(result).toContain("data-blocked-src='https://cdn.example.com/img.jpg'");
  });

  it("handles HTML with no images", () => {
    const html = "<p>Hello world</p>";
    const result = stripRemoteImages(html);
    expect(result).toBe(html);
  });

  it("strips url() in inline CSS", () => {
    const html = '<div style="background-image: url(https://tracker.com/bg.png)">text</div>';
    const result = stripRemoteImages(html);
    expect(result).not.toContain("https://tracker.com/bg.png");
  });
});

describe("restoreRemoteImages", () => {
  it("restores blocked images", () => {
    const original = '<img src="https://cdn.example.com/image.png" alt="photo" />';
    const blocked = stripRemoteImages(original);
    const restored = restoreRemoteImages(blocked);
    expect(restored).toContain('src="https://cdn.example.com/image.png"');
    expect(restored).not.toContain("data-blocked-src");
  });

  it("handles HTML with no blocked images", () => {
    const html = '<img src="data:image/png;base64,abc" />';
    const result = restoreRemoteImages(html);
    expect(result).toBe(html);
  });
});

describe("hasBlockedImages", () => {
  it("returns true when blocked images exist", () => {
    const html = '<img data-blocked-src="https://cdn.example.com/img.png" src="" />';
    expect(hasBlockedImages(html)).toBe(true);
  });

  it("returns false when no blocked images", () => {
    const html = '<img src="https://cdn.example.com/img.png" />';
    expect(hasBlockedImages(html)).toBe(false);
  });

  it("returns false for empty HTML", () => {
    expect(hasBlockedImages("")).toBe(false);
  });

  it("returns false for data-blocked-src with data: URI", () => {
    const html = '<img data-blocked-src="data:image/png;base64,abc" />';
    expect(hasBlockedImages(html)).toBe(false);
  });
});

describe("throughApp", () => {
  const via = (url: string) => `app://${url}`;

  it("points remote images and inline-style backgrounds at the app, and leaves the rest", () => {
    const html = '<img src="https://claude.ai/a.png?x=1&amp;y=2"><img src="data:image/png;base64,AA"><div style="background:url(\'https://x.example/b.jpg\')">t</div>';
    const out = throughApp(html, via);
    expect(out).toContain('src="app://https://claude.ai/a.png?x=1&amp;y=2"');
    expect(out).toContain('data-web="https://claude.ai/a.png?x=1&amp;y=2"');
    expect(out).toContain('src="data:image/png;base64,AA"');
    expect(out).toContain("url('app://https://x.example/b.jpg')");
  });

  it("never asks for an image the blocking took out", () => {
    const out = throughApp(stripRemoteImages('<img src="https://t.example/p.png">'), via);
    expect(out).not.toContain("app://");
  });
});

it("gives the app's address for a URL as base64url under voa-img", () => {
  const url = appImage((path, protocol) => `${protocol}://localhost/${path}`, "https://claude.ai/a.png?x=1&y=2");
  const b64 = url.split("/").pop()!.replace(/-/g, "+").replace(/_/g, "/");
  expect(url.startsWith("voa-img://localhost/")).toBe(true);
  expect(atob(b64)).toBe("https://claude.ai/a.png?x=1&y=2");
});
