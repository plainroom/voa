import { act, renderHook, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { Heard } from "../ai/listen";

let hear: (h: Heard) => void = () => {};
const stopped = vi.fn();
vi.mock("../ai/listen", () => ({
  listen: vi.fn(async (on: (h: Heard) => void) => {
    hear = on;
    return stopped;
  }),
}));
vi.mock("../ai/claude", () => ({
  claudeVersion: vi.fn(async () => "2.0"),
  askClaude: vi.fn(async () => "<p>Oi Rasna,</p><p>Vou atrasar 10 minutos.</p>"),
  bodyOf: (s: string) => s,
  closeClaude: vi.fn(),
}));
vi.mock("../ai/tasks/write", () => ({ ownReplies: vi.fn(async () => []), writingSettings: vi.fn(async () => ({ learn: false, note: "" })) }));

import { askClaude } from "../ai/claude";
import { useToastStore } from "../ui/Toast";
import { useCopilot } from "./copilot";

const editor = { isEmpty: true, getHTML: () => "", commands: { setContent: vi.fn(), focus: vi.fn() } } as unknown as Editor;
const account = { id: "a", email: "me@example.com" };

async function speaking() {
  const hook = renderHook(() => useCopilot(editor, account, () => ({ conversation: "", to: "Rasna" })));
  await waitFor(() => expect(hook.result.current.claude.connected).toBe(true));
  act(() => hook.result.current.speak());
  act(() => hear({ text: "diz pra rasna que vou atrasar" }));
  expect(hook.result.current.listening?.text).toBe("diz pra rasna que vou atrasar");
  return hook;
}

describe("Speak", () => {
  it("sends what was heard once it stops", async () => {
    const { result } = await speaking();
    act(() => result.current.stop(true));
    await waitFor(() => expect(stopped).toHaveBeenCalled());
    // The bar stays, writing, until Claude answers.
    expect(result.current.listening?.sent).toBe(true);
    act(() => hear({ done: "diz pra rasna que vou atrasar" }));
    await waitFor(() => expect(editor.commands.setContent).toHaveBeenCalled());
    expect(vi.mocked(askClaude).mock.calls[0]![2]).toContain("Request: (said aloud) diz pra rasna que vou atrasar");
    await waitFor(() => expect(result.current.listening).toBeNull());
  });

  it("Esc drops it: nothing goes to Claude", async () => {
    vi.mocked(askClaude).mockClear();
    const { result } = await speaking();
    act(() => result.current.stop(false));
    expect(result.current.listening).toBeNull();
    act(() => hear({ done: "diz pra rasna que vou atrasar" }));
    expect(askClaude).not.toHaveBeenCalled();
  });

  it("a helper that ends without a word gives Speak back, said", async () => {
    const { result } = await speaking();
    act(() => hear({ why: "ended" }));
    expect(result.current.listening).toBeNull();
    expect(useToastStore.getState().current?.message).toBe("Couldn't listen");
  });

  it("a dropped session's last lines do not end the next one", async () => {
    const { result } = await speaking();
    const first = hear;
    act(() => result.current.stop(false));
    act(() => result.current.speak());
    act(() => first({ done: "diz pra rasna que vou atrasar" }));
    act(() => first({ why: "ended" }));
    expect(result.current.listening).toEqual({ levels: [], text: "", sent: false });
  });
});
