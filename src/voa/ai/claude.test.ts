import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const { askClaude, bodyOf } = await import("./claude");

beforeEach(() => invoke.mockReset());

it("takes the email out of a code fence, and leaves one without as it is", () => {
  expect(bodyOf("```html\n<p>Oi</p>\n```")).toBe("<p>Oi</p>");
  expect(bodyOf("<p>Oi</p>\n")).toBe("<p>Oi</p>");
});

it("puts one blank line between the paragraphs, however many came", () => {
  expect(bodyOf("<p>Oi Rasna,</p>\n\n<p>Vou atrasar.</p><p></p><ul><li>a</li></ul>")).toBe("<p>Oi Rasna,</p><p></p><p>Vou atrasar.</p><p></p><ul><li>a</li></ul>");
});

it("builds the instructions only when the session has to be opened", async () => {
  const instructions = vi.fn(async () => "you write emails");
  invoke.mockResolvedValueOnce("<p>one</p>");
  expect(await askClaude("d", instructions, "first")).toBe("<p>one</p>");
  expect(instructions).not.toHaveBeenCalled();

  invoke.mockRejectedValueOnce("claude: no session").mockResolvedValueOnce(undefined).mockResolvedValueOnce("<p>two</p>");
  expect(await askClaude("d", instructions, "second")).toBe("<p>two</p>");
  expect(instructions).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("claude_open", { id: "d", instructions: "you write emails" });
});

it("passes any other failure on, without opening a session", async () => {
  invoke.mockRejectedValueOnce("Claude took too long");
  await expect(askClaude("d", async () => "x", "q")).rejects.toBe("Claude took too long");
  expect(invoke).toHaveBeenCalledTimes(1);
});
