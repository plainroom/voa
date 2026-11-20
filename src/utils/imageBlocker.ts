/**
 * Utility functions for blocking/restoring remote images in email HTML.
 * Preserves data: and cid: URIs, only blocks http/https remote images.
 */

/**
 * Strip remote images from HTML by moving src to data-blocked-src.
 * Also strips remote url() references in inline styles.
 */
export function stripRemoteImages(html: string): string {
  // Replace <img src="http..."> with data-blocked-src
  let result = html.replace(
    /(<img\b[^>]*?)(\ssrc\s*=\s*)(["'])(https?:\/\/[^"']*)\3/gi,
    '$1 data-blocked-src=$3$4$3 src=$3$3',
  );

  // Replace background-image: url(http...) in inline styles
  result = result.replace(
    /url\(\s*(["']?)(https?:\/\/[^)"']*)\1\s*\)/gi,
    'url($1$1)',
  );

  return result;
}

/**
 * Restore previously blocked remote images by moving data-blocked-src back to src.
 */
export function restoreRemoteImages(html: string): string {
  return html.replace(
    /(<img\b[^>]*?)\sdata-blocked-src\s*=\s*(["'])(https?:\/\/[^"']*)\2([^>]*?)\ssrc\s*=\s*(["'])\5/gi,
    '$1 src=$2$3$2$4',
  );
}

/**
 * Check if an HTML string contains any blocked images.
 */
export function hasBlockedImages(html: string): boolean {
  return /data-blocked-src\s*=\s*["']https?:\/\//i.test(html);
}

/**
 * Points every remote image of a sanitized mail (an img's src, a url() in an inline style) at `via`,
 * which gives the address the app serves it from (`voa-img`, src-tauri/src/images.rs): the app
 * fetches it, so rules a sender set for browsers do not hide it. An img keeps its own URL in
 * data-web, for the reader to ask for it itself when the app could not. Run after the blocking, so a
 * blocked image is never asked for.
 */
export function throughApp(html: string, via: (url: string) => string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const remote = /^https?:\/\//i;
  doc.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!remote.test(src)) return;
    img.setAttribute("src", via(src));
    img.setAttribute("data-web", src);
  });
  doc.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") ?? "";
    const next = style.replace(/url\(\s*(["']?)(https?:\/\/[^)"']*)\1\s*\)/gi, (_, q: string, url: string) => `url(${q}${via(url)}${q})`);
    if (next !== style) el.setAttribute("style", next);
  });
  return doc.body.innerHTML;
}

/** The address the app serves a remote image from: its URL, in base64url, under voa-img. */
export function appImage(convert: (path: string, protocol: string) => string, url: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(url)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return convert(b64, "voa-img");
}
