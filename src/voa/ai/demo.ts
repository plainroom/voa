import type { Subject } from "./apple";
import type { Heard } from "./listen";
import type { Labels } from "./tasks/labels";

/**
 * The browser demo's stand-ins for what runs on the Mac (Apple's model, Claude Code, the microphone): set only by
 * demo/fixture.ts, which never runs inside the app. Unset, every call goes to the Mac as usual.
 */
export const demoAI: {
  ask?: (task: string, subject: Subject) => Promise<unknown>;
  claude?: (text: string) => Promise<string>;
  /** The rows' labels, by `<account>:<thread>`. */
  labels?: Map<string, Labels>;
  listen?: (on: (heard: Heard) => void) => () => void;
} = {};
