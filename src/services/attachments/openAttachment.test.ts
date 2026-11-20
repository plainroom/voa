const fs = { exists: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), remove: vi.fn(async () => {}), BaseDirectory: { Temp: 12 } };
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/path", () => ({ tempDir: async () => "/tmp/", join: async (...p: string[]) => p.join("").replace("//", "/") }));
const opener = { openPath: vi.fn(), revealItemInDir: vi.fn() };
vi.mock("@tauri-apps/plugin-opener", () => opener);
const fetchAttachment = vi.fn();
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/services/email/providerFactory", () => ({ getEmailProvider: async () => ({ fetchAttachment }) }));

import type { DbAttachment } from "@/services/db/attachments";
import { base64UrlToBytes, openAttachment, opensDirectly, safeFileName } from "./openAttachment";

const att = (filename: string | null): DbAttachment => ({
  id: "m1_ANGjdJ8",
  message_id: "m1",
  account_id: "a",
  filename,
  mime_type: "application/pdf",
  size: 10,
  gmail_attachment_id: "ANGjdJ8",
  content_id: null,
  is_inline: 0,
  local_path: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  fs.exists.mockResolvedValue(false);
  fetchAttachment.mockResolvedValue({ data: "aGk", size: 2 });
});

describe("openAttachment", () => {
  it("downloads the file under a partial name, quarantines it, renames it whole, then opens it", async () => {
    await openAttachment(att("Proposal.pdf"));
    expect(fetchAttachment).toHaveBeenCalledWith("m1", "ANGjdJ8");
    const [partial, bytes, opts] = fs.writeFile.mock.calls[0]!;
    expect(partial).toMatch(/^voa\/[a-z0-9]+_[a-z0-9]+\/Proposal\.pdf\.[a-z0-9]+\.part$/);
    // A leading dot is a hidden file to the fs scope's globs, which refuse it.
    expect((partial as string).split("/").pop()!.startsWith(".")).toBe(false);
    expect(new TextDecoder().decode(bytes)).toBe("hi");
    expect(opts).toEqual({ baseDir: 12 });
    const [from, to, renameOpts] = fs.rename.mock.calls[0]!;
    expect(from).toBe(partial);
    expect(to).toMatch(/^voa\/[a-z0-9]+_[a-z0-9]+\/Proposal\.pdf$/);
    expect(renameOpts).toEqual({ oldPathBaseDir: 12, newPathBaseDir: 12 });
    // Quarantined before the rename, so the real name never exists without the mark.
    expect(invoke).toHaveBeenCalledWith("quarantine_file", { path: `/tmp/${partial}` });
    expect(invoke.mock.invocationCallOrder[0]!).toBeLessThan(fs.rename.mock.invocationCallOrder[0]!);
    expect(invoke).toHaveBeenLastCalledWith("quarantine_file", { path: `/tmp/${to}` });
    expect(opener.openPath).toHaveBeenCalledWith(`/tmp/${to}`);
  });

  it("a write cut short leaves no file under the real name, so the next click downloads again", async () => {
    fs.writeFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(openAttachment(att("Proposal.pdf"))).rejects.toThrow("disk full");
    expect(fs.rename).not.toHaveBeenCalled();
    expect(opener.openPath).not.toHaveBeenCalled();
    // The partial file is removed, and the cache check asked only for the real name.
    expect(fs.remove).toHaveBeenCalledWith(fs.writeFile.mock.calls[0]![0], { baseDir: 12 });
    for (const [checked] of fs.exists.mock.calls) expect(checked).toMatch(/\/Proposal\.pdf$/);
    await openAttachment(att("Proposal.pdf"));
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });

  it("a second open reuses the whole file, quarantining it again (one cached before the mark gets it)", async () => {
    fs.exists.mockResolvedValue(true);
    await openAttachment(att("Proposal.pdf"));
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("quarantine_file", { path: expect.stringMatching(/Proposal\.pdf$/) });
    expect(opener.openPath).toHaveBeenCalled();
  });

  it("a quarantine that fails opens nothing", async () => {
    invoke.mockRejectedValueOnce(new Error("Not an attachment file"));
    await expect(openAttachment(att("Proposal.pdf"))).rejects.toThrow();
    expect(opener.openPath).not.toHaveBeenCalled();
    expect(opener.revealItemInDir).not.toHaveBeenCalled();
  });

  it("anything not a document or media file is shown in Finder, not opened", async () => {
    await openAttachment(att("invoice.command"));
    expect(opener.openPath).not.toHaveBeenCalled();
    expect(opener.revealItemInDir).toHaveBeenCalledWith(expect.stringMatching(/invoice\.command$/));
  });

  it("fails without an attachment id", async () => {
    await expect(openAttachment({ ...att("x.pdf"), gmail_attachment_id: null })).rejects.toThrow();
  });
});

describe("safeFileName", () => {
  it("keeps only the name, never a folder, a hidden dot or control characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\x.pdf")).toBe("x.pdf");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("a\u0000b:c.txt")).toBe("a_b_c.txt");
    expect(safeFileName(null)).toBe("attachment");
  });
  it("shortens a long name and keeps its extension", () => {
    const long = safeFileName(`${"x".repeat(300)}.pdf`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("opensDirectly", () => {
  it("opens documents and media, whatever the case of the extension", () => {
    for (const n of ["a.pdf", "b.PNG", "c.jpeg", "d.heic", "e.txt", "f.csv", "g.md", "h.rtf", "i.docx", "j.xls", "k.pptx", "l.pages", "m.numbers", "n.key", "o.mp3", "p.m4a", "q.MP4", "r.mov", "s.ics", "t.eml", "u.webp", "v.gif"])
      expect(opensDirectly(n), n).toBe(true);
  });
  it("reveals everything else: code, archives, disk images, HTML, no extension, a document name hiding another type", () => {
    for (const n of ["Setup.app", "x.command", "x.sh", "x.pkg", "x.dmg", "x.zip", "x.html", "x.svg", "x.jar", "x.terminal", "x.webloc", "x.inetloc", "README", "pdf", "invoice.pdf.command", "x.docm"])
      expect(opensDirectly(n), n).toBe(false);
  });
});

it("base64UrlToBytes", () => {
  expect([...base64UrlToBytes("_-8")]).toEqual([255, 239]);
});
