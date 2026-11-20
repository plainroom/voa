const OPENABLE = /^(https?:|mailto:)/i;

/**
 * Prepares the links of a mail body for its sandboxed iframe. WebKit runs no
 * listener inside a frame sandboxed without allow-scripts, so a click cannot be
 * intercepted there: an http(s) or mailto link becomes a popup instead
 * (target _blank), which the Rust shell turns into the system browser or mail
 * app. Every other href (javascript:, data:, relative, `#...`, which would
 * drive the app's hash router) is dropped, on `<a>` and `<area>` alike.
 */
export function isolateLinks(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const link of Array.from(template.content.querySelectorAll("a[href], area[href]"))) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (OPENABLE.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("href");
      link.removeAttribute("target");
    }
  }
  return template.innerHTML;
}
