import { invoke } from "@tauri-apps/api/core";
import type { DbMessage } from "@/services/db/messages";
import { demoAI } from "./demo";
import { mailText } from "./mailText";

/**
 * The owner's own Claude Code, the writing copilot (see src-tauri/src/claude.rs): one session per draft, kept open
 * while the draft is, so each request builds on the ones before.
 */

/** Claude Code's version, or null when this Mac has none. */
export const claudeVersion = () => (demoAI.claude ? Promise.resolve("demo") : invoke<string | null>("claude_version")).catch(() => null);

/**
 * One request to the draft's session. A session not open yet (or closed after a failure) is opened first, with
 * `instructions`, which are only read then.
 */
export async function askClaude(id: string, instructions: () => Promise<string>, text: string): Promise<string> {
  if (demoAI.claude) return demoAI.claude(text);
  try {
    return await invoke<string>("claude_ask", { id, text });
  } catch (err) {
    if (!String(err).includes("no session")) throw err;
  }
  await invoke("claude_open", { id, instructions: await instructions() });
  return invoke<string>("claude_ask", { id, text });
}

export const closeClaude = (id: string) => void invoke("claude_close", { id }).catch(() => {});

/**
 * The email as the editor takes it: a fence the model may put around it is no part of the email, and a blank line
 * goes between its paragraphs, as the owner types them (the editor shows paragraphs with no space between).
 */
export function bodyOf(answer: string): string {
  const html = answer
    .trim()
    .replace(/^```[a-z]*\n/i, "")
    .replace(/\n```$/, "")
    .trim();
  const blocks = [...new DOMParser().parseFromString(html, "text/html").body.children].filter(
    (el) => el.tagName !== "P" || el.textContent?.trim() || el.querySelector("img"),
  );
  return blocks.map((el) => el.outerHTML).join("<p></p>");
}

/** What Claude reads of a conversation: each message's sender, date and own words (not what it quotes), the newest last. */
export function thread(messages: DbMessage[]): string {
  const text = messages
    .map((m) => {
      const from = m.from_name ? `${m.from_name} <${m.from_address ?? ""}>` : (m.from_address ?? "Someone");
      return `From: ${from}\nDate: ${new Date(m.date).toISOString().slice(0, 16).replace("T", " ")}\n\n${mailText(m.body_html, m.body_text, true).text}`;
    })
    .join("\n\n---\n\n");
  // ponytail: the end of a very long thread, which is what the reply answers; Claude takes far more than this.
  return text.slice(-40_000);
}
