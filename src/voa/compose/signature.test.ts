import { expect, it } from "vitest";
import { withSignature } from "./signature";

it("puts the signature after the mail, escaped, its lines kept", () => {
  expect(withSignature("<p>Oi</p>", "Vagner\n<Assis>")).toBe('<p>Oi</p><br><div class="voa-signature">Vagner<br>&lt;Assis&gt;</div>');
  expect(withSignature("<p>Oi</p>", "  ")).toBe("<p>Oi</p>");
});
