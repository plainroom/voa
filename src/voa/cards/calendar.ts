/** An .ics written to the temp dir (the only place the fs and opener scopes allow) and opened: Calendar takes it. */
export async function openIcs(name: string, ics: string): Promise<void> {
  const { BaseDirectory, mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
  const { join, tempDir } = await import("@tauri-apps/api/path");
  const { openPath } = await import("@tauri-apps/plugin-opener");
  const relative = `voa/${name.replace(/[^A-Za-z0-9_-]/g, "_")}.ics`;
  await mkdir("voa", { baseDir: BaseDirectory.Temp, recursive: true });
  await writeTextFile(relative, ics, { baseDir: BaseDirectory.Temp });
  await openPath(await join(await tempDir(), relative));
}

/** A link opened in the browser; a failure only logs. */
export async function openLink(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url).catch((err: unknown) => console.warn("open link failed", err));
}
