import { isolateLinks } from "./openEmailLinks";

function parse(html: string): Document {
  return new DOMParser().parseFromString(isolateLinks(html), "text/html");
}

describe("isolateLinks", () => {
  it("sends http, https and mailto links out as popups", () => {
    const doc = parse(
      '<a href="https://example.com/x">a</a><a href=" HTTP://example.com/y">b</a><a href="mailto:a@b.com">c</a>' +
        '<map name="m"><area href="https://example.com/z" shape="rect" coords="0,0,1,1"></map>',
    );
    const links = Array.from(doc.querySelectorAll("a, area"));
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(doc.querySelector("area")?.getAttribute("href")).toBe("https://example.com/z");
  });

  it("drops every other href, on links and image-map areas alike", () => {
    const doc = parse(
      '<a href="#/settings">router</a><a href="#top">anchor</a><a href="javascript:alert(1)">js</a>' +
        '<a href="data:text/html,x">data</a><a href="/relative" target="_top">rel</a>' +
        '<map name="m"><area href="#/compose" target="_top"><area href="javascript:alert(2)"></map>',
    );
    expect(doc.querySelectorAll("[href]")).toHaveLength(0);
    expect(doc.querySelectorAll("[target]")).toHaveLength(0);
    expect(doc.body.textContent).toContain("router");
  });
});
