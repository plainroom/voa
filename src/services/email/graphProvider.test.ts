import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  move: vi.fn(async () => null as string | null),
  patch: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  sendMail: vi.fn(async () => {}),
  folders: vi.fn(async () => [{ id: "f1", displayName: "Archive", wellKnownName: "archive", totalItemCount: 2, unreadItemCount: 0 }]),
  createFolder: vi.fn(async () => ({ id: "f2", displayName: "Trips" })),
  deleteFolder: vi.fn(async () => {}),
  renameFolder: vi.fn(async () => {}),
  attachment: vi.fn(async () => ({ data: "YQ==", size: 1 })),
  messages: vi.fn(async () => []),
  attachments: vi.fn(async () => []),
  rawMessage: vi.fn(async () => "From: a@b.c"),
};

const { replaceMessageId, getMessagesForThread } = vi.hoisted(() => ({
  replaceMessageId: vi.fn(async () => {}),
  getMessagesForThread: vi.fn(async () => [{ id: "m1" }]),
}));

vi.mock("../graph/tokenManager", () => ({
  getGraphClient: vi.fn(async () => client),
}));

vi.mock("../db/messages", () => ({
  replaceMessageId,
  getMessagesForThread,
}));

import { GraphProvider } from "./graphProvider";

describe("GraphProvider", () => {
  const provider = new GraphProvider("acc");

  beforeEach(() => {
    client.move.mockClear();
    client.patch.mockClear();
    client.remove.mockClear();
    client.sendMail.mockClear();
    replaceMessageId.mockClear();
    getMessagesForThread.mockClear();
  });

  it("archives, trashes and reports spam by moving to the well-known folder", async () => {
    await provider.archive("t", ["m1"]);
    await provider.trash("t", ["m1"]);
    await provider.spam("t", ["m1"], true);
    await provider.spam("t", ["m1"], false);
    expect(client.move.mock.calls).toEqual([
      ["m1", "archive"],
      ["m1", "deleteditems"],
      ["m1", "junkemail"],
      ["m1", "inbox"],
    ]);
  });

  it("stars and marks read on the message", async () => {
    await provider.star("t", ["m1"], true);
    await provider.markRead("t", ["m1"], false);
    expect(client.patch.mock.calls).toEqual([
      ["m1", { flag: { flagStatus: "flagged" } }],
      ["m1", { isRead: false }],
    ]);
  });

  it("deletes and sends through Graph", async () => {
    await provider.permanentDelete("t", ["m1"]);
    await provider.sendMessage("YQ");
    expect(client.remove).toHaveBeenCalledWith("m1");
    expect(client.sendMail).toHaveBeenCalledWith("YQ");
  });

  it("follows the id Graph assigns when a message moves", async () => {
    client.move.mockResolvedValueOnce("m2");
    await provider.archive("t", ["m1"]);
    expect(replaceMessageId).toHaveBeenCalledWith("acc", "m1", "m2");
  });

  it("puts the inbox label back by moving the message into the inbox", async () => {
    getMessagesForThread.mockResolvedValueOnce([{ id: "m9" }]);
    await provider.addLabel("t", "INBOX");
    expect(client.move).toHaveBeenCalledWith("m9", "inbox");
  });

  it("drops a local label without asking Graph to move the message", async () => {
    await provider.removeLabel("t", "STARRED");
    await provider.removeLabel("t", "SNOOZED");
    expect(client.move).not.toHaveBeenCalled();
  });

  it("takes a thread out of Deleted Items when the trash label goes (undo a delete from Starred)", async () => {
    getMessagesForThread.mockResolvedValueOnce([{ id: "m9" }]);
    client.move.mockResolvedValueOnce("m10");
    await provider.removeLabel("t", "TRASH");
    expect(client.move).toHaveBeenCalledWith("m9", "archive");
    expect(replaceMessageId).toHaveBeenCalledWith("acc", "m9", "m10");
  });

  it("takes a thread out of Junk into the inbox when the spam label goes", async () => {
    getMessagesForThread.mockResolvedValueOnce([{ id: "m9" }]);
    await provider.removeLabel("t", "SPAM");
    expect(client.move).toHaveBeenCalledWith("m9", "inbox");
  });

  it("lists folders, moves into one, and opens an attachment", async () => {
    expect(await provider.listFolders()).toEqual([
      expect.objectContaining({ id: "f1", name: "Archive", path: "f1", type: "system" }),
    ]);
    await provider.moveToFolder("t", ["m1"], "f1");
    expect(client.move).toHaveBeenCalledWith("m1", "f1");
    expect(await provider.fetchAttachment("m1", "file-1")).toEqual({ data: "YQ==", size: 1 });
  });

});
