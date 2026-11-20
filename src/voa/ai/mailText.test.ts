import { describe, expect, it } from "vitest";
import { mailText } from "./mailText";

describe("mailText", () => {
  it("numbers the links and drops styles", () => {
    const { text, links } = mailText('<style>p{}</style><p>Código: LETBVQ</p><a href="https://x.example/m">Administrar</a><a href="mailto:a@b">mail</a>', null);
    expect(text).toBe("Código: LETBVQ Administrar [link 1] mail");
    expect(links).toEqual(["https://x.example/m"]);
  });
});
