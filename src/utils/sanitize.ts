import DOMPurify from "dompurify";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A size the mail gives an image, in pixels: its attribute, or its inline style when that is in px. */
function declared(img: HTMLImageElement, side: "width" | "height"): number | null {
  const style = img.style[side];
  if (style.endsWith("px")) return parseFloat(style);
  const attr = img.getAttribute(side);
  return attr != null && /^\d+(\.\d+)?$/.test(attr.trim()) ? parseFloat(attr) : null;
}

/**
 * An image no one can see is there only to report that the mail was opened (a tracking pixel): hidden, or at most
 * 1 px on a side. It goes before rendering, so it is never fetched, and a slow one never holds the mail's load.
 */
function invisible(img: HTMLImageElement): boolean {
  if (img.style.display === "none" || img.style.visibility === "hidden") return true;
  return [declared(img, "width"), declared(img, "height")].some((size) => size != null && size <= 1);
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLImageElement && invisible(node)) node.remove();
});

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // The reader's own data-* (data-web, which the reader loads when the app could not) never come from the sender.
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "width", "height", "class", "style",
      "target", "rel", "colspan", "rowspan", "cellpadding", "cellspacing",
      "border", "align", "valign", "bgcolor", "color", "dir", "lang",
      "data-blocked-src",
    ],
  });
}
