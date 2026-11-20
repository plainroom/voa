import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Ban, Check, Clock, Inbox, Languages, OctagonAlert, ScrollText, Star } from "lucide-react";
import { EmailRenderer } from "@/voa/thread/EmailRenderer";
import { InlineReply } from "@/voa/thread/InlineReply";
import { useTranslate } from "@/voa/thread/Translate";
import type { Translation } from "../ai/translate";
import type { DbAttachment } from "@/services/db/attachments";
import type { DbMessage } from "@/services/db/messages";
import { isStarred, type DbThread, type ThreadKey } from "@/services/db/threads";
import { isNoReplyAddress } from "@/utils/noReply";
import { inboxSource } from "../inbox/source";
import { useInbox } from "../inbox/useInbox";
import { RemindPicker } from "../remind/RemindPicker";
import { LIST_PATH, useVoaStore } from "@/stores/list";
import { AccountDot, AttachmentChip, Button, IconButton, useToast } from "../ui";
import { normalizeEmail } from "@/utils/emailUtils";
import { MailCards } from "../cards/MailCards";
import { ConversationSummary } from "../cards/SummaryCard";
import { known } from "../ai/apple";
import { conversation, summary } from "../ai/tasks/summary";

type Images = { block: boolean; allowed: ReadonlySet<string> };

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const sentAt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

const NO_ATTACHMENTS: DbAttachment[] = [];

/**
 * The files to list under a message: not the images its body shows (cid:), not nameless inline
 * parts, and one of each name and size (Gmail repeats a file forwarded inline and attached).
 */
function fileAttachments(attachments: DbAttachment[], bodyHtml: string | null): DbAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((a) => {
    if (a.content_id && bodyHtml?.includes(`cid:${a.content_id}`)) return false;
    if (a.is_inline && !a.filename) return false;
    const key = `${a.filename}:${a.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Attachments({ files }: { files: DbAttachment[] }) {
  const { show } = useToast();
  const [opening, setOpening] = useState<string | null>(null);
  if (files.length === 0) return null;
  const open = async (a: DbAttachment) => {
    setOpening(a.id);
    try {
      await inboxSource().openAttachment(a);
    } catch (err) {
      console.error("voa could not open the attachment:", err);
      show(`Couldn't open ${a.filename ?? "the attachment"}`);
    } finally {
      setOpening(null);
    }
  };
  return (
    <div className="flex flex-wrap gap-2 pt-4">
      {files.map((a) => (
        <AttachmentChip key={a.id} name={a.filename || "Unnamed"} size={a.size} busy={opening === a.id} onOpen={() => void open(a)} />
      ))}
    </div>
  );
}

function Message({
  message,
  dotColor,
  expanded,
  onToggle,
  images,
  attachments,
  fetching,
  translated,
  scrollTo,
}: {
  message: DbMessage;
  dotColor: string | null;
  expanded: boolean;
  onToggle: () => void;
  images: Images | null;
  attachments: DbAttachment[];
  /** The body is being fetched (the message was stored with headers only). */
  fetching: boolean;
  /** The body in another language (Translate, T), shown instead of the original. */
  translated: Translation | null;
  /** Opens scrolled to this message (the newest of several), once its body has its height: before, the page is too short to get there. */
  scrollTo: boolean;
}) {
  const name = message.from_name || message.from_address || "Unknown sender";
  const files = useMemo(() => fileAttachments(attachments, message.body_html), [attachments, message.body_html]);
  const inline = useMemo(() => attachments.filter((a) => a.content_id), [attachments]);
  const article = useRef<HTMLElement>(null);
  // Once: a body drawn again (Translate) leaves the page where the person is.
  const scrolled = useRef(false);
  const sized = useCallback(() => {
    if (!scrollTo || scrolled.current) return;
    scrolled.current = true;
    article.current?.scrollIntoView({ block: "start" });
  }, [scrollTo]);
  return (
    <article ref={article} className="border-t border-line first:border-t-0">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-baseline gap-3 py-4 text-left">
        <span className="flex self-center">
          <AccountDot color={dotColor} />
        </span>
        <span className="text-title font-semibold text-ink">{name}</span>
        {expanded ? (
          <>
            {message.from_name && message.from_address && <span className="truncate text-meta text-ink-3">{message.from_address}</span>}
            <span className="flex-1" />
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-body text-ink-3">{message.snippet}</span>
        )}
        <span className="shrink-0 text-meta text-ink-3 tabular-nums">{sentAt.format(new Date(message.date))}</span>
      </button>
      {expanded && (
        <div className="pb-6 pl-[18px]">
          <MailCards message={message} attachments={attachments} open={expanded} />
          {message.body_pending === 1 ? (
            // Still waiting: the fetch is on its way, or it failed and the preview is all there is.
            <p className="text-body text-ink-3">{fetching ? "Loading…" : message.snippet}</p>
          ) : message.body_unavailable === 1 && message.body_html == null && message.body_text == null ? (
            // The provider no longer has it (moved or deleted elsewhere): the preview, and why there is no more.
            <div className="text-body text-ink-3">
              {message.snippet && <p>{message.snippet}</p>}
              <p>This message is no longer available.</p>
            </div>
          ) : images && (
            <EmailRenderer
              html={translated && "html" in translated ? translated.html : message.body_html}
              text={translated && "text" in translated ? translated.text : message.body_text}
              blockImages={images.block}
              senderAddress={message.from_address}
              accountId={message.account_id}
              senderAllowlisted={message.from_address ? images.allowed.has(message.from_address) : false}
              messageId={message.id}
              inlineAttachments={inline}
              onSized={sized}
            />
          )}
          <Attachments files={files} />
        </div>
      )}
    </article>
  );
}

/**
 * Reading: one conversation, full screen. E, S and H act and open the next conversation of the
 * list (back to the list when there is none); ! marks spam, U unsubscribes, B blocks the sender;
 * R and A reply inline; Esc goes back, the row still selected.
 */
export function ThreadScreen() {
  const { accountId, threadId } = useParams({ from: "/t/$accountId/$threadId" });
  const key = useMemo<ThreadKey>(() => ({ accountId, threadId }), [accountId, threadId]);
  const navigate = useNavigate();
  const list = useVoaStore((s) => s.list);
  const select = useVoaStore((s) => s.select);
  const inbox = useInbox(list);

  const [thread, setThread] = useState<DbThread | undefined>();
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [images, setImages] = useState<Images | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [attachments, setAttachments] = useState<Record<string, DbAttachment[]>>({});
  const [reminding, setReminding] = useState<Date | null>(null);
  /** Bodies of messages a search stored with headers only are on their way. */
  const [fetching, setFetching] = useState(false);
  /** Unsubscribe failed, so Block takes its place. */
  const [blockInstead, setBlockInstead] = useState(false);
  /** The summary is shown (Summarize, I), for this conversation only. */
  const [summarizing, setSummarizing] = useState(false);
  const translate = useTranslate(messages, `${accountId}:${threadId}`);
  const { show } = useToast();

  // A summary made before shows again by itself (kept per conversation and note); only a new one waits for I.
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!lastId || !("__TAURI_INTERNALS__" in window)) return;
    let live = true;
    known(summary, conversation(messages))
      .then((s) => live && s && setSummarizing(true))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  // Whatever opened this conversation, it is the list's selected row when Esc goes back.
  useEffect(() => select(key), [key, select]);

  useEffect(() => {
    let cancelled = false;
    setThread(undefined);
    setMessages([]);
    setImages(null);
    setOpened(new Set());
    setAttachments({});
    setBlockInstead(false);
    setSummarizing(false);
    setFetching(false);
    const source = inboxSource();
    void (async () => {
      try {
        const [t, first] = await Promise.all([source.thread(key), source.messages(key)]);
        if (cancelled) return;
        setThread(t);
        setMessages(first);
        const senders = [...new Set(first.map((m) => m.from_address).filter((a): a is string => !!a))];
        const policy = await source.imagePolicy(key, senders).catch((): Images => ({ block: true, allowed: new Set() }));
        if (cancelled) return;
        setImages(policy);
        // A search stored some messages with headers only: their bodies come now, before anything reads or marks them.
        let ms = first;
        if (first.some((m) => m.body_pending === 1)) {
          setFetching(true);
          try {
            await source.fetchBodies(key);
            ms = await source.messages(key);
            if (!cancelled) setMessages(ms);
          } catch (err) {
            console.error("voa could not fetch the conversation's bodies:", err);
          } finally {
            if (!cancelled) setFetching(false);
          }
          if (cancelled) return;
        }
        // Attachments are extra: a failure to read them leaves the messages readable.
        void Promise.all(ms.map(async (m) => [m.id, await source.attachments(m.account_id, m.id).catch(() => NO_ATTACHMENTS)] as const)).then(
          (pairs) => !cancelled && setAttachments(Object.fromEntries(pairs)),
        );
        if (t && t.is_read === 0) await source.markRead(key);
      } catch (err) {
        console.error("voa could not open the conversation:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const back = useCallback(() => void navigate({ to: LIST_PATH[list] }), [navigate, list]);

  const accountEmail = inbox.accounts.find((a) => a.id === accountId)?.email ?? null;
  const mine = accountEmail ? normalizeEmail(accountEmail) : "";
  const showUnsub = !blockInstead && messages.some((m) => !!m.list_unsubscribe);
  const showBlock =
    !showUnsub &&
    messages.some((m) => {
      if (!m.from_address) return false;
      const address = normalizeEmail(m.from_address);
      return address !== "" && address !== mine;
    });
  const showSpam = list !== "SPAM" && !!thread;
  const showStar = list !== "SNOOZED" && list !== "TRASH" && !!thread;

  const openThread = useCallback(
    (k: ThreadKey) => {
      select(k);
      void navigate({ to: "/t/$accountId/$threadId", params: { accountId: k.accountId, threadId: k.threadId } });
    },
    [navigate, select],
  );

  /**
   * Runs an exit and moves on at once: the next conversation, or the list with none left. The row stays
   * hidden there until its write lands (the hidden set is shared), and comes back if the write fails.
   */
  const leave = async (act: (k: ThreadKey) => Promise<void>) => {
    const after = inbox.next(key);
    void act(key);
    if (after) openThread(after);
    else back();
  };

  const unsubscribe = async () => {
    try {
      await inboxSource().unsubscribe(key);
    } catch (err) {
      console.error("voa could not unsubscribe:", err);
      show("Couldn't unsubscribe");
      setBlockInstead(true);
      return;
    }
    void leave((k) => inbox.unsubscribed(k));
  };

  /**
   * Why a reply cannot be written yet, or null. A search's headers-only row has no Message-ID, To, Cc or Reply-To:
   * a reply from it would go to the wrong people or out of the conversation, so it waits for the full message.
   */
  const replyBlocked = fetching
    ? "Reply opens once the message has loaded."
    : messages.some((m) => m.body_pending === 1 || (m.body_unavailable === 1 && m.body_html == null && m.body_text == null))
      ? "Reply needs the full message, which couldn't be loaded."
      : null;

  const handlers = useRef({ leave, inbox, list, back, setReminding, unsubscribe, showUnsub, showBlock, showSpam, replyBlocked, setSummarizing, translate });
  handlers.current = { leave, inbox, list, back, setReminding, unsubscribe, showUnsub, showBlock, showSpam, replyBlocked, setSummarizing, translate };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target) || document.querySelector('[role="dialog"]')) return;
      const { leave, inbox, list, back, setReminding, unsubscribe, showUnsub, showBlock, showSpam, replyBlocked, setSummarizing, translate } = handlers.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void inbox.undoLast();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const reply = (mode: "reply" | "replyAll") => window.dispatchEvent(new CustomEvent("voa-inline-reply", { detail: { mode } }));
      switch (e.key) {
        case "Escape":
          back();
          break;
        case "e":
          if (list === "INBOX") void leave(inbox.done);
          if (list === "TRASH" || list === "DONE") void leave(inbox.restore);
          break;
        case "s":
          if (list !== "SNOOZED" && list !== "TRASH") void leave(inbox.star);
          break;
        case "h":
          if (list !== "STARRED" && list !== "TRASH") setReminding(new Date());
          break;
        case "!":
          if (showSpam) void leave(inbox.spam);
          break;
        case "u":
          if (showUnsub) void unsubscribe();
          break;
        case "b":
          if (showBlock) void leave(inbox.block);
          break;
        case "r":
          if (!replyBlocked) reply("reply");
          break;
        case "a":
          if (!replyBlocked) reply("replyAll");
          break;
        case "i":
          setSummarizing((on) => !on);
          break;
        case "t":
          void translate.toggle();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const colorOf = (id: string) => inbox.accounts.find((a) => a.id === id)?.color ?? null;
  const last = messages[messages.length - 1];
  const noReply = isNoReplyAddress(last?.reply_to ?? last?.from_address);

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      <header data-tauri-drag-region className="shrink-0 px-8 pt-9 pb-1 select-none">
        <div data-tauri-drag-region className="flex h-9 items-center gap-2">
          <IconButton label="Back" keys="Esc" onClick={back}>
            <ArrowLeft size={15} strokeWidth={1.75} />
          </IconButton>
          <span className="ml-auto flex items-center gap-1">
            {thread && messages.length > 0 && (
              <IconButton label={translate.translating ? "Show original" : "Translate"} keys="T" onClick={() => void translate.toggle()}>
                <Languages size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {thread && messages.length > 0 && (
              <IconButton label={summarizing ? "Hide summary" : "Summarize"} keys="I" onClick={() => setSummarizing((on) => !on)}>
                <ScrollText size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {list === "INBOX" && (
              <IconButton label="Done" keys="E" onClick={() => void leave(inbox.done)}>
                <Check size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {(list === "TRASH" || list === "DONE") && (
              <IconButton label="Move to Inbox" keys="E" onClick={() => void leave(inbox.restore)}>
                <Inbox size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {list !== "STARRED" && list !== "TRASH" && (
              <IconButton label="Remind me" keys="H" onClick={() => setReminding(new Date())}>
                <Clock size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {showStar && (
              <IconButton label={isStarred(thread) ? "Unstar" : "Star"} keys="S" onClick={() => void leave(inbox.star)}>
                <Star size={15} strokeWidth={1.75} fill={isStarred(thread) ? "currentColor" : "none"} />
              </IconButton>
            )}
            {showSpam && (
              <IconButton label="Spam" keys="!" onClick={() => void leave(inbox.spam)}>
                <OctagonAlert size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {showBlock && (
              <IconButton label="Block" keys="B" onClick={() => void leave(inbox.block)}>
                <Ban size={15} strokeWidth={1.75} />
              </IconButton>
            )}
            {showUnsub && <Button onClick={() => void unsubscribe()}>Unsubscribe</Button>}
          </span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-8 pb-24">
          <h1 className="pt-4 pb-4 text-display font-semibold">{thread?.subject || (thread ? "(no subject)" : "")}</h1>
          {translate.bar}
          {summarizing && messages.length > 0 && <ConversationSummary messages={messages} />}
          {messages.map((m, i) => (
            <Message
              key={m.id}
              message={m}
              dotColor={colorOf(m.account_id)}
              expanded={i === messages.length - 1 || opened.has(m.id)}
              onToggle={() =>
                setOpened((s) => {
                  const next = new Set(s);
                  if (!next.delete(m.id)) next.add(m.id);
                  return next;
                })
              }
              images={images}
              attachments={attachments[m.id] ?? NO_ATTACHMENTS}
              fetching={fetching}
              translated={translate.translated(m)}
              scrollTo={i === messages.length - 1 && messages.length > 1}
            />
          ))}
          {thread && last && replyBlocked ? (
            <p className="pt-4 pl-[18px] text-meta text-ink-3">{replyBlocked}</p>
          ) : thread && last && (
            // Stays at the bottom of the screen while a long mail scrolls under it: replying never needs the end of the mail. Closed it sits on the keys line; open, above it.
            <div className="sticky bottom-0 -mx-4 flow-root bg-canvas">
              <InlineReply key={`${accountId}:${threadId}`} thread={thread} messages={messages} accountId={accountId} noReply={noReply} onSent={() => {}} />
            </div>
          )}
        </div>
      </main>

      <footer className="pointer-events-none fixed right-8 bottom-4 text-meta text-ink-3 select-none">E done · R reply · H remind · I summarize · Esc back</footer>

      {translate.picker}
      {reminding && (
        <RemindPicker
          opened={reminding}
          onClose={() => setReminding(null)}
          onPick={(until) => {
            setReminding(null);
            void leave((k) => inbox.remind(k, unix(until)));
          }}
        />
      )}
    </div>
  );
}
