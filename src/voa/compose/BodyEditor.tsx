import { useEffect } from "react";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";

/** StarterKit binds Mod-Enter to a hard break; the screen sends on it instead, so swallow it here (the event still bubbles). */
const SendKeyPassthrough = Extension.create({
  name: "sendKeyPassthrough",
  priority: 1000,
  addKeyboardShortcuts: () => ({ "Mod-Enter": () => true }),
});

const CELL = "border: 1px solid #d0d0d5; padding: 6px 12px; text-align: left; vertical-align: top";

/**
 * Tables, as Claude writes them ("monta uma tabela"), styled inline: the style goes out with the email, where the
 * recipient's app has none of ours.
 */
export const mailTables = TableKit.configure({
  table: { resizable: false, HTMLAttributes: { style: "border-collapse: collapse; margin: 8px 0" } },
  tableCell: { HTMLAttributes: { style: CELL } },
  tableHeader: { HTMLAttributes: { style: `${CELL}; font-weight: 600` } },
});

/** Bold, italic, link, lists and tables, and nothing else. Lists start by typing "- " or "1. ". */
export function BodyEditor({ initialHtml, onEditor }: { initialHtml: string; onEditor: (editor: Editor | null) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: { openOnClick: false, autolink: true },
      }),
      SendKeyPassthrough,
      mailTables,
      Placeholder.configure({ placeholder: "Write your message, or ⌘J to write it with Claude" }),
    ],
    content: initialHtml,
  });

  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  return (
    <EditorContent
      editor={editor}
      className="min-h-48 text-body text-ink [&_.ProseMirror]:min-h-48 [&_.ProseMirror]:outline-none [&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-ink-3 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_a]:text-accent [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}
