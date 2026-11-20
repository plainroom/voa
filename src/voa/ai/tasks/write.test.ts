import { expect, it } from "vitest";
import { firstName } from "./write";

it("greets by first name only a sender who gave a name", () => {
  expect(firstName({ from_name: "Ana Lima", from_address: "ana@x.com" })).toBe("Ana");
  expect(firstName({ from_name: "barte@ses-mail.inhire.app", from_address: "barte@ses-mail.inhire.app" })).toBe("");
  expect(firstName({ from_name: null, from_address: "ana@x.com" })).toBe("");
});
