import { render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { BodyEditor } from "./BodyEditor";

describe("BodyEditor", () => {
  it("Mod-Enter inserts no hard break, so the screen's send wins", async () => {
    let editor: Editor | null = null;
    render(<BodyEditor initialHtml="<p>hi</p>" onEditor={(e) => void (editor = e)} />);
    await waitFor(() => expect(editor).not.toBeNull());
    editor!.commands.focus("end");
    const view = editor!.view;
    const press = (init: KeyboardEventInit) => view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter", ...init })));
    const mac = /Mac|iP(hone|ad)/.test(navigator.platform);
    expect(press(mac ? { metaKey: true } : { ctrlKey: true })).toBe(true);
    expect(editor!.getHTML()).toBe("<p>hi</p>");
  });
});
