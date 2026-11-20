import { describe, expect, it } from "vitest";
import { checkLabels, labels } from "./labels";

describe("checkLabels", () => {
  it("keeps a known kind and the reply flag", () => {
    expect(checkLabels({ kind: " News ", respond: false })).toEqual({ kind: "news", respond: false });
    expect(checkLabels({ kind: "work", respond: true })).toEqual({ kind: "work", respond: true });
  });

  it("drops a kind the model made up, but not its reply flag", () => {
    expect(checkLabels({ kind: "promotion", respond: true })).toEqual({ kind: null, respond: true });
    expect(checkLabels("text")).toBeNull();
  });
});

it("asks one kind among the ones Settings lists, and respond apart", () => {
  const props = (labels.schema as { properties: { name?: string; description?: string }[] }).properties;
  expect(props.map((p) => p.name)).toEqual(["kind", "respond"]);
  expect(props[0]?.description).toContain("invoice (bills, receipts and payment notices)");
});
