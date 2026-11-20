/**
 * A right click shows no menu: voa is an app, not a page, so the webview's own (Back, Reload,
 * Open Image in New Window) has nothing to offer. Selected text and a field you type in keep theirs
 * (Look Up, Translate, Copy, spelling, paste). Inspect Element is gone from every menu with the
 * release build's devtools. Called on the app's document and on each mail's frame, whose events never
 * reach the app's.
 */
export function noContextMenu(doc: Document): void {
  doc.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, [contenteditable='true']") || doc.getSelection()?.toString().trim()) return;
    e.preventDefault();
  });
}
