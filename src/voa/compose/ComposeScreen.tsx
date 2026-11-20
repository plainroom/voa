import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { AddressInput } from "@/voa/compose/AddressInput";
import { inboxSource, MaybeSentError, type InboxAccount } from "../inbox/source";
import { Button, Field, Select, TextField, useToast } from "../ui";
import { BodyEditor } from "./BodyEditor";
import { Copilot, useCopilot } from "./copilot";
import { nameOf } from "../ai/tasks/write";
import { getSignature, SignaturePreview, useSignature, withSignature } from "./signature";
import { clearDraft, lastOpenThreadAccount, peekDraft, stashDraft } from "./draftStash";
import { forgetUnsentMessage } from "./unsentMessages";
import { useToastStore } from "../ui/Toast";

const looksLikeAddress = (a: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a);

/** From: the account of the conversation last open, else the one last sent from, else the first. */
async function defaultFrom(accounts: InboxAccount[]): Promise<string | null> {
  const known = (id: string | null | undefined) => (id && accounts.some((a) => a.id === id) ? id : null);
  return known(lastOpenThreadAccount()) ?? known(await inboxSource().lastFromAccount().catch(() => null)) ?? accounts[0]?.id ?? null;
}

/** A new message: From, To, Subject, body. Cmd+Enter sends; Esc discards, with Undo to bring it back. */
export function ComposeScreen() {
  const navigate = useNavigate();
  const { show } = useToast();
  const [restored] = useState(peekDraft);
  const [accounts, setAccounts] = useState<InboxAccount[]>([]);
  const [from, setFrom] = useState<string | null>(restored?.accountId ?? null);
  const [to, setTo] = useState<string[]>(restored?.to ?? []);
  const [subject, setSubject] = useState(restored?.subject ?? "");
  const [sending, setSending] = useState(false);
  const editor = useRef<Editor | null>(null);
  const toBox = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const [body, setBody] = useState<Editor | null>(null);
  const setEditor = useCallback((e: Editor | null) => {
    editor.current = e;
    setBody(e);
  }, []);
  const copilot = useCopilot(
    body,
    accounts.find((a) => a.id === from),
    // A new email answers nothing: Claude knows who it goes to, by the name their own mail gives, else their address.
    useCallback(async () => ({ conversation: "", to: to[0] ? (await nameOf(to[0]).catch(() => "")) || to[0] : "" }), [to]),
  );

  useEffect(() => {
    clearDraft();
    toBox.current?.querySelector("input")?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    void (async () => {
      const list = await inboxSource().accounts();
      if (!current) return;
      setAccounts(list);
      if (!restored?.accountId) setFrom(await defaultFrom(list));
    })();
    return () => {
      current = false;
    };
  }, [restored]);

  const signature = useSignature();
  const bodyHtml = () => (editor.current?.isEmpty ? "" : (editor.current?.getHTML() ?? ""));

  /** The stored copy of the unsent message this was reopened from, if any. */
  const unsentId = restored?.unsentId;
  const forgetUnsent = () => {
    if (unsentId) void forgetUnsentMessage(unsentId).catch((err) => console.error("voa could not drop the unsent copy:", err));
  };

  const discard = () => {
    const draft = { accountId: from, to, subject, html: bodyHtml(), unsentId };
    const empty = to.length === 0 && !subject.trim() && !draft.html;
    // Discarding is the owner's word on it: the stored copy goes (Undo still brings the message back to the screen).
    forgetUnsent();
    void navigate({ to: "/" });
    if (empty) return;
    show("Draft discarded", async () => {
      stashDraft(draft);
      void navigate({ to: "/compose" });
    });
  };

  const send = async () => {
    const account = accounts.find((a) => a.id === from);
    if (!account || sendingRef.current) return;
    // An address typed but not yet turned into a chip still counts.
    const typed = toBox.current?.querySelector("input")?.value.trim();
    const recipients = [...new Set([...to, ...(typed ? [typed] : [])])];
    if (recipients.length === 0) return show("Add a recipient");
    const bad = recipients.find((a) => !looksLikeAddress(a));
    if (bad) return show(`"${bad}" is not an address`);

    // Optimistic: the screen closes at once and the send runs behind it. A failure offers the message back
    // (Open); a quit mid-send is caught at the next start by the unsent notice.
    sendingRef.current = true;
    setSending(true);
    const html = bodyHtml();
    const draft = { accountId: account.id, to: recipients, subject, html, unsentId };
    void navigate({ to: "/" });
    show("Sending…");
    try {
      // The signature goes out with it; the draft kept for Open is what was written.
      await inboxSource().send(account.id, { from: account.email, to: recipients, subject, html: withSignature(html, await getSignature()) });
    } catch (err) {
      console.error("voa send failed:", err);
      const reopen = () => {
        stashDraft(draft);
        void navigate({ to: "/compose" });
      };
      const notice = err instanceof MaybeSentError ? "It may have been sent. Check Sent before sending again." : "Couldn't send.";
      return useToastStore.getState().showAction(notice, "Open", reopen);
    }
    forgetUnsent();
    void inboxSource().setLastFromAccount(account.id).catch(() => {});
    show("Sent");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (copilot.key(e)) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Mid-send there is nothing to discard, and an Undo could send it twice.
      if (!sendingRef.current) discard();
    }
  };

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink" onKeyDown={onKeyDown}>
      <header data-tauri-drag-region className="shrink-0 px-8 pt-9 pb-1 select-none">
        <div data-tauri-drag-region className="flex h-9 items-center justify-between">
          <h1 className="text-title font-semibold">New message</h1>
          <div className="flex items-center gap-1">
            <Button onClick={discard} disabled={sending}>Discard Esc</Button>
            <Button variant="primary" onClick={() => void send()} disabled={sending}>
              Send ⌘↵
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-1 px-8 pt-4 pb-24">
          {accounts.length > 1 && (
            <Field label="From">
              <Select aria-label="From" value={from ?? ""} onChange={(e) => setFrom(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name === a.email ? a.email : `${a.name} <${a.email}>`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div ref={toBox}>
            <AddressInput label="To" addresses={to} onChange={setTo} placeholder="" />
          </div>
          <Field label="Subject">
            <TextField aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <div className="pt-4">
            <Copilot editor={body} copilot={copilot} />
            <BodyEditor initialHtml={restored?.html ?? ""} onEditor={setEditor} />
            <SignaturePreview text={signature} />
          </div>
        </div>
      </main>
    </div>
  );
}
