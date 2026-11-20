import { describe, expect, it } from "vitest";
import { noContextMenu } from "./contextMenu";

describe("noContextMenu", () => {
  it("shows no menu on a right click, but keeps it on selected text and in a field you type in", () => {
    document.body.innerHTML = '<p id="p">text</p><input id="i"><div contenteditable="true"><span id="e">x</span></div>';
    noContextMenu(document);
    const click = (id: string) => !document.getElementById(id)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(click("p")).toBe(true);
    expect(click("i")).toBe(false);
    expect(click("e")).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p")!);
    document.getSelection()!.addRange(range);
    expect(click("p")).toBe(false); // selected text keeps Look Up, Translate, Copy
  });
});
