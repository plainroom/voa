import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The reader's "Load images" shows a message's remote images, which the CSP must then allow
// (EmailRenderer still blocks them until the owner asks).
it("the CSP lets https images load", () => {
  const conf = JSON.parse(readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"));
  const imgSrc = (conf.app.security.csp as string).split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));
  expect(imgSrc?.split(/\s+/)).toContain("https:");
});
