import { describe, expect, it } from "vitest";
import { revoked, setSignedOut, useSignedOut } from "./signedOut";

describe("signedOut", () => {
  it("tells OAuth's invalid_grant from any other failure", () => {
    expect(revoked('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')).toBe(true);
    expect(revoked('{"error":"invalid_client"}')).toBe(false);
    expect(revoked("<html>502</html>")).toBe(false);
  });

  it("keeps an account signed out until it is signed in again", () => {
    setSignedOut("a", true);
    expect(useSignedOut.getState().ids.has("a")).toBe(true);
    setSignedOut("a", false);
    expect(useSignedOut.getState().ids.has("a")).toBe(false);
  });
});
