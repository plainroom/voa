import { Channel, invoke } from "@tauri-apps/api/core";
import { demoAI } from "./demo";

/** What the microphone gives while it listens (src-tauri/ai/main.swift, `listen`). */
export type Heard = { level: number } | { text: string } | { done: string } | { why: "microphone" | "unsupported" | "ended" };

/** Listens until `stop`: each line the helper prints goes to `on`, the last one `done` or `why` (`ended` when it stopped without a word). */
export async function listen(on: (heard: Heard) => void): Promise<() => void> {
  if (demoAI.listen) return demoAI.listen(on);
  const lines = new Channel<string>();
  lines.onmessage = (line) => on(JSON.parse(line) as Heard);
  await invoke("listen_start", { lines });
  return () => void invoke("listen_stop").catch(() => {});
}
