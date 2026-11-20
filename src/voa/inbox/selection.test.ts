import type { ThreadKey } from "@/services/db/threads";
import { rangePicked, togglePicked } from "./selection";

const a: ThreadKey = { accountId: "a", threadId: "1" };
const b: ThreadKey = { accountId: "a", threadId: "2" };
const c: ThreadKey = { accountId: "a", threadId: "3" };
const rows = [a, b, c];

describe("selection", () => {
  it("cmd-click adds a row and a second click takes it back out", () => {
    const one = togglePicked([], a);
    expect(one).toEqual([a]);
    expect(togglePicked(one, b)).toEqual([a, b]);
    expect(togglePicked([a, b], a)).toEqual([b]);
  });

  it("shift-click takes the rows between the anchor and the click", () => {
    expect(rangePicked(rows, 0, 2).map((k) => k.threadId)).toEqual(["1", "2", "3"]);
    expect(rangePicked(rows, 2, 1).map((k) => k.threadId)).toEqual(["2", "3"]);
    expect(rangePicked(rows, 1, 1).map((k) => k.threadId)).toEqual(["2"]);
  });
});
