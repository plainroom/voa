import { describe, expect, it } from "vitest";
import { translateHtml, translateText } from "./translate";

const upper = async (texts: string[]) => texts.map((t) => t.toUpperCase());

describe("translateHtml", () => {
  it("translates each piece of text in place and keeps the markup and styles", async () => {
    const out = await translateHtml('<style>p{color:red}</style><p>hi <a href="https://x.com">there</a></p>', upper);
    expect(out).toContain("<p>HI <a href=\"https://x.com\">THERE</a></p>");
    expect(out).toContain("p{color:red}");
  });

  it("is nothing when the translation fails", async () => {
    expect(await translateHtml("<p>hi</p>", async () => null)).toBeNull();
  });
});

describe("translateText", () => {
  it("translates by paragraph, a wrapped line staying with its sentence", async () => {
    const seen: string[][] = [];
    const out = await translateText("one\ntwo\n\nthree", async (t) => (seen.push(t), upper(t)));
    expect(seen).toEqual([["one\ntwo", "three"]]);
    expect(out).toBe("ONE\nTWO\n\nTHREE");
  });
});
