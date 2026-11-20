import type { DbAttachment } from "@/services/db/attachments";
import { getEmailProvider } from "@/services/email/providerFactory";

/** Where opened attachments are written, under the system temp dir (the fs and opener scopes allow only this). */
const DIR = "voa";

/** A short, filesystem-safe folder name for an attachment id (Gmail's ids run to hundreds of characters). */
function hashFileName(id: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    h1 = ((h1 * 33) ^ ch) >>> 0;
    h2 = ((h2 * 33) ^ ch) >>> 0;
  }
  return `${h1.toString(36)}_${h2.toString(36)}`;
}

/** The sender's file name made safe to write: no folders, no control characters, not hidden, not too long. */
export function safeFileName(name: string | null): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").replace(/^[.\s]+/, "").trim();
  if (clean.length > 120) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return clean || "attachment";
}

/** Documents and media, opened with their app from a click. Anything else is revealed in Finder, never opened. */
const OPENS = new Set(
  "pdf png jpg jpeg gif heic webp txt csv md rtf doc docx xls xlsx ppt pptx pages numbers key mp3 m4a mp4 mov ics eml".split(" "),
);
export const opensDirectly = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && OPENS.has(name.slice(dot + 1).toLowerCase());
};

export function base64UrlToBytes(data: string): Uint8Array {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Downloads an attachment through its account's provider (once: a second click reuses the file) to
 * the temp dir, marks it quarantined (so Gatekeeper checks it like a browser download) and opens a
 * document with its app, or reveals anything else in Finder. Throws when it could not.
 */
export async function openAttachment(att: DbAttachment): Promise<void> {
  if (!att.gmail_attachment_id) throw new Error("The attachment has no id to fetch it by");
  const { BaseDirectory, exists, mkdir, remove, rename, writeFile } = await import("@tauri-apps/plugin-fs");
  const { invoke } = await import("@tauri-apps/api/core");
  const { join, tempDir } = await import("@tauri-apps/api/path");
  const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");

  const name = safeFileName(att.filename);
  const folder = `${DIR}/${hashFileName(`${att.account_id}:${att.id}`)}`;
  const relative = `${folder}/${name}`;
  const baseDir = BaseDirectory.Temp;

  const temp = await tempDir();
  if (!(await exists(relative, { baseDir }))) {
    const provider = await getEmailProvider(att.account_id);
    const { data } = await provider.fetchAttachment(att.message_id, att.gmail_attachment_id);
    await mkdir(folder, { baseDir, recursive: true });
    // Written under another name and renamed when whole (quarantined first, so the real name never
    // exists without it): a write cut short is never taken for the file by a later click, and is removed.
    // No leading dot: the fs scope's globs treat a dot file as hidden and refuse it.
    const partial = `${relative}.${Date.now().toString(36)}.part`;
    try {
      await writeFile(partial, base64UrlToBytes(data), { baseDir });
      await invoke("quarantine_file", { path: await join(temp, partial) });
      await rename(partial, relative, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
    } catch (err) {
      await remove(partial, { baseDir }).catch(() => {});
      throw err;
    }
  }

  const path = await join(temp, relative);
  // Again on every open: a file cached before voa quarantined them gets the mark too.
  await invoke("quarantine_file", { path });
  if (opensDirectly(name)) await openPath(path);
  else await revealItemInDir(path);
}
