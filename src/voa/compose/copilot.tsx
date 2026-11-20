import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { BriefcaseBusiness, ChevronsDownUp, CornerDownLeft, Mic, Smile } from "lucide-react";
import { askClaude, bodyOf, claudeVersion, closeClaude } from "../ai/claude";
import { listen } from "../ai/listen";
import { ownReplies, writingSettings } from "../ai/tasks/write";
import { useToast } from "../ui";

/** What the email is written with: the conversation it answers (empty for a new email) and who it goes to. */
export type CopilotContext = { conversation: string; to: string };

type Account = { id: string; email: string; displayName?: string | null; name?: string };

const ownName = (account: Account) => (account.displayName || account.name || account.email.split("@")[0] || "").split(" ")[0] ?? "";

// ponytail: checked once per app run; Connect checks again.
let installed: Promise<string | null> | null = null;

/** Whether this Mac has Claude Code: null while it is being checked. */
function useClaudeCode() {
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    installed ??= claudeVersion();
    void installed.then(setVersion);
  }, []);
  const connect = async () => {
    installed = claudeVersion();
    const found = await installed;
    setVersion(found);
    return found;
  };
  return { connected: version === undefined ? null : !!version, connect };
}

/** The instructions of the draft's session: who writes, how, and what Claude answers with. */
async function instructions(account: Account): Promise<string> {
  const name = ownName(account);
  const { learn, note } = await writingSettings();
  const examples = learn ? await ownReplies(account.id, account.email) : [];
  return [
    `You write and edit emails in an email app, for ${name}. Answer with the email body only, as HTML, nothing before or after it and no code fence.`,
    // Left to itself it wrote a block of text, closed with a sign-off and padded short news with pleasantries.
    `The shape of every email: the greeting alone in its own <p> (like "Oi Rasna," or "Hi John,"), then the message in short paragraphs, one <p> each, a paragraph per idea. Lists and tables only when asked or when there are several items to compare. No subject line. Never a sign-off or ${name}'s name at the end: their signature is added after.`,
    `Concise by default: as few sentences as the message needs, plain words, no filler and no pleasantries ${name} did not ask for. Write as ${name}, in the first person, to the person it goes to, in the language of the conversation, or of their request when there is none, unless they ask for another.`,
    "When there is a draft, change it as asked and keep the rest as it is. Say only what the request or the conversation gives: no promise, fact or detail of your own.",
    // Asked "Opa, beleza?" aloud, it answered the owner with a question, and the question became the email.
    `Every request is ${name} telling you about this email, never a conversation with you: never answer or ask ${name} anything. When a request is no instruction, it is what the email says.`,
    // "Diz para Hasma" (Rasna, misheard) became "tell Hasma" inside the email to Rasna.
    `A request said aloud comes as a transcript, with misheard words: a name that sounds like someone of this email (who it goes to, the conversation) is that person, and "tell X" about the person it goes to is what to write to them. Read every other odd word as what makes sense here.`,
    note ? `How ${name} writes, in their words: ${note}` : "",
    examples.length ? `Emails ${name} wrote, for their voice:\n${examples.map((e) => `- ${e}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The writing copilot (⌘J): requests to the owner's Claude Code that write the email or change it, one after another
 * in the draft's own session, so "make it shorter" knows what it was. ⌘Z takes a change back.
 */
export function useCopilot(editor: Editor | null, account: Account | undefined, context: () => CopilotContext | Promise<CopilotContext>) {
  const { show } = useToast();
  const claude = useClaudeCode();
  // One session per draft and account: a new From writes in that account's name and voice.
  const draft = useMemo(() => crypto.randomUUID(), []);
  const id = `${draft}:${account?.id ?? ""}`;
  useEffect(() => () => closeClaude(id), [id]);
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [working, setWorking] = useState<string | null>(null);

  const send = useCallback(
    async (said: string, label = said) => {
      if (!editor || !account || working || !said.trim()) return;
      setWorking(label);
      try {
        const { conversation, to } = await context();
        const html = editor.isEmpty ? "(empty)" : editor.getHTML();
        const text = [
          conversation ? `The conversation the email answers:\n${conversation}` : to ? `The email goes to: ${to}` : "",
          `The draft now:\n${html}`,
          `Request: ${said}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const answer = bodyOf(await askClaude(id, () => instructions(account), text));
        if (!answer) return show("Claude did not write anything");
        editor.commands.setContent(answer, { emitUpdate: true });
        editor.commands.focus("end");
        setHistory((h) => [...h, label]);
        setRequest("");
      } catch (err) {
        console.warn("claude failed", err);
        show(`Claude: ${String(err).slice(0, 120)}`);
      } finally {
        setWorking(null);
      }
    },
    [editor, account, working, context, id, show],
  );

  /** A tone: a request of its own, on what is selected when something is, else on the whole email. */
  const tone = (label: string, how: string) => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const part = empty ? "" : editor.state.doc.textBetween(from, to, "\n");
    void send(part ? `${how}, changing only this part and keeping the rest exactly as it is: "${part}"` : how, label);
  };

  const close = useCallback(() => {
    setAsking(false);
    editor?.commands.focus();
  }, [editor]);

  /**
   * Speak (⌘⇧J): the request said aloud, heard on this Mac, and sent once it stops (⏎); Esc drops it. `session` is the one
   * listening now: the lines of one stopped, dropped or replaced are not read.
   */
  const [listening, setListening] = useState<{ levels: number[]; text: string; sent: boolean } | null>(null);
  const session = useRef<{ stop: () => void } | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const drop = () => {
    session.current?.stop();
    session.current = null;
  };
  useEffect(() => drop, []);
  const speak = () => {
    if (session.current || claude.connected !== true || working) return;
    // A stop before the helper is up waits for it.
    const now = { stop: () => void stopping.then((stop) => stop()) };
    const stopping = listen((heard) => {
      if (session.current !== now) return;
      if ("level" in heard) setListening((l) => (l && !l.sent ? { ...l, levels: [...l.levels, heard.level].slice(-BARS) } : l));
      else if ("text" in heard) setListening((l) => l && { ...l, text: heard.text });
      else {
        session.current = null;
        if ("why" in heard) show(WHY[heard.why]);
        if ("done" in heard && heard.done) {
          // The bar stays, with what was heard, until Claude has written it.
          setListening((l) => l && { ...l, text: heard.done, sent: true });
          void sendRef.current(`(said aloud) ${heard.done}`, heard.done).finally(() => setListening(null));
        } else {
          setListening(null);
          editor?.commands.focus();
        }
      }
    });
    session.current = now;
    setListening({ levels: [], text: "", sent: false });
    stopping.catch((err: unknown) => {
      console.warn("listen failed", err);
      if (session.current !== now) return;
      session.current = null;
      setListening(null);
      show(WHY.ended);
    });
  };
  /** Ends listening: `keep` sends what was said, else it is dropped. */
  const stop = (keep: boolean) => {
    if (keep) {
      session.current?.stop();
      setListening((l) => l && { ...l, sent: true });
    } else {
      drop();
      setListening(null);
      editor?.commands.focus();
    }
  };

  /** ⌘J opens the bar, ⌘⇧J speaks (or ends speaking), from the box's own keys; true when it was one of them. */
  const key = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "j") return false;
    e.preventDefault();
    if (!e.shiftKey) setAsking(true);
    else if (session.current) stop(true);
    else speak();
    return true;
  };

  return { claude, asking, open: () => setAsking(true), close, request, setRequest, history, working, send, tone, listening, speak, stop, key };
}

/** What keeps Speak from listening, as the owner reads it. */
const WHY = {
  microphone: "voa needs the microphone: allow it in Privacy & Security › Microphone",
  unsupported: "This Mac cannot hear your language yet",
  ended: "Couldn't listen",
} as const;

/** The level's track: one bar per fifteenth of a second heard, newest on the right, starting full of silence. */
const BARS = 32;

const Key = ({ children }: { children: string }) => (
  <span className="rounded-[4px] border border-line px-1 text-[11px] leading-4 font-medium text-ink-3">{children}</span>
);

/** The bar ⌘J opens above the text: the requests made so far, then the next one. Enter sends, Esc closes. */
function CopilotBar({ copilot }: { copilot: ReturnType<typeof useCopilot> }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div className="mb-3 rounded-panel bg-surface px-3.5 py-2 shadow-float">
      {copilot.history.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-line pt-0.5 pb-2">
          {copilot.history.map((h, i) => (
            <span key={i} className="rounded-full bg-selected px-2 py-0.5 text-meta text-ink-2">
              {h}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2.5 pt-1">
        <input
          ref={field}
          aria-label="Ask Claude"
          placeholder="Ask Claude to write or change the email"
          value={copilot.request}
          disabled={!!copilot.working}
          onChange={(e) => copilot.setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void copilot.send(copilot.request);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              copilot.close();
            }
          }}
          className="h-7 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3 disabled:text-ink-3"
        />
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-ink-3">
          {copilot.working ? (
            <span className="animate-pulse">Claude is writing…</span>
          ) : (
            <>
              <CornerDownLeft size={12} strokeWidth={1.75} /> send · <Key>Esc</Key>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

const TONES = [
  { label: "Friendly", how: "Make it friendlier and warmer, saying the same things", Icon: Smile },
  { label: "Professional", how: "Make it more professional and polished, saying the same things", Icon: BriefcaseBusiness },
  { label: "Concise", how: "Make it shorter and more direct, keeping every point", Icon: ChevronsDownUp },
] as const;

/** Whether the editor has text, followed as it changes: the tones have nothing to rewrite until it does. */
function useHasText(editor: Editor | null): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const check = () => setHas(!!editor.getText().trim());
    check();
    editor.on("update", check);
    return () => void editor.off("update", check);
  }, [editor]);
  return has;
}

/**
 * The copilot's line above the text: Write with Claude (⌘J) and the tones, which wait for text. Without Claude Code on
 * this Mac all of it is off, with Connect Claude Code to look again.
 */
function CopilotLine({ editor, copilot }: { editor: Editor | null; copilot: ReturnType<typeof useCopilot> }) {
  const { show } = useToast();
  const hasText = useHasText(editor);
  const on = copilot.claude.connected === true;
  // No focus on press: a click would take it, and the selection with it, from the text the tones work on.
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const connect = async () => {
    const found = await copilot.claude.connect();
    show(found ? `Connected to Claude Code ${found}` : "Claude Code is not installed. Install it, sign in once with claude in a terminal, then connect.");
  };
  return (
    <p className="mb-3 flex items-center gap-3 text-meta text-ink-3">
      <button type="button" onMouseDown={keep} onClick={copilot.open} disabled={!on} className="flex items-center gap-1.5 text-ink-2 hover:text-ink disabled:text-ink-3 disabled:opacity-60">
        Write with Claude <Key>⌘J</Key>
      </button>
      <button
        type="button"
        onMouseDown={keep}
        onClick={copilot.speak}
        disabled={!on || !!copilot.working || !!copilot.listening}
        className="flex items-center gap-1.5 text-ink-2 hover:text-ink disabled:text-ink-3 disabled:opacity-60"
      >
        <Mic size={13} strokeWidth={1.75} /> Speak <Key>⌘⇧J</Key>
      </button>
      <span className="h-3.5 w-px bg-line" />
      {TONES.map(({ label, how, Icon }) => (
        <button
          key={label}
          type="button"
          onMouseDown={keep}
          onClick={() => copilot.tone(label, how)}
          disabled={!on || !hasText || !!copilot.working}
          className="flex items-center gap-1.5 text-ink-2 hover:text-ink disabled:text-ink-3 disabled:opacity-60"
        >
          <Icon size={13} strokeWidth={1.75} /> {copilot.working === label ? <span className="animate-pulse">{label}…</span> : label}
        </button>
      ))}
      {copilot.claude.connected === false && (
        <>
          <span className="flex-1" />
          <button type="button" onClick={() => void connect()} className="text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
            Connect Claude Code
          </button>
        </>
      )}
    </p>
  );
}

/** The copilot above the text: its line, and the bar while a request is being written. */
export function Copilot({ editor, copilot }: { editor: Editor | null; copilot: ReturnType<typeof useCopilot> }) {
  return (
    <>
      <CopilotLine editor={editor} copilot={copilot} />
      {copilot.listening ? <Listening copilot={copilot} /> : copilot.asking && <CopilotBar copilot={copilot} />}
    </>
  );
}

/** While Speak listens: what was heard so far (light and italic until sent), and under it bars that move along with the voice. ⏎ sends it, Esc drops it. */
function Listening({ copilot }: { copilot: ReturnType<typeof useCopilot> }) {
  const { levels, text, sent } = copilot.listening!;
  const stop = useRef(copilot.stop);
  stop.current = copilot.stop;
  useEffect(() => {
    if (sent) return;
    // Before the box's own keys (Esc there discards the draft).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stop.current(e.key === "Enter");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sent]);
  return (
    <div className="mb-3 rounded-panel bg-surface px-3.5 py-2.5 shadow-float">
      <p className={`text-body ${!text ? "text-ink-3" : sent ? "text-ink" : "text-ink-2 italic"}`}>{text || (levels.length ? "Say what to write or change" : "Getting ready…")}</p>
      <div className="mt-2 flex items-center justify-between text-meta text-ink-3">
        {sent ? (
          <span className="animate-pulse">Claude is writing…</span>
        ) : (
          <>
            <span aria-hidden="true" className="flex h-4 items-center gap-[2px]">
              {[...Array<number>(BARS - levels.length).fill(0), ...levels].map((l, i) => (
                <span key={i} className="w-[2px] rounded-full bg-ink-2" style={{ height: 2 + Math.round(l * 14) }} />
              ))}
            </span>
            <span className="flex items-center gap-1.5">
              <CornerDownLeft size={12} strokeWidth={1.75} /> send · <Key>Esc</Key>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
