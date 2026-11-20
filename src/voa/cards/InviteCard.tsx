import { ArrowUpRight, CalendarPlus, Video } from "lucide-react";
import { useEffect, useState } from "react";
import type { DbAttachment } from "@/services/db/attachments";
import { getSetting, setSetting } from "@/services/db/settings";
import { getEmailProvider } from "@/services/email/providerFactory";
import { useAccountStore } from "@/stores/accountStore";
import { base64UrlToBytes } from "@/services/attachments/openAttachment";
import { Button, useToast } from "../ui";
import { openIcs, openLink } from "./calendar";
import { readInvite, replyMail, type Invite, type Reply } from "./invite";
import type { CardProps } from "./MailCards";

const month = new Intl.DateTimeFormat("en-US", { month: "short" });
const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function when(inv: Invite): string {
  if (inv.allDay) return `${day.format(inv.start)} · All day`;
  return `${day.format(inv.start)} · ${hour.format(inv.start)}${inv.end ? ` to ${hour.format(inv.end)}` : ""}`;
}

const LABEL: Record<Reply, string> = { yes: "Yes", maybe: "Maybe", no: "No" };
const ANSWERED: Record<Reply, string> = { yes: "accepted", maybe: "might attend", no: "declined" };

/** The invitation over its mail: the day, the time, who invited, the answer, the call's link. */
export function InviteCard({
  invite,
  reply,
  busy,
  onReply,
  onAdd,
}: {
  invite: Invite;
  reply: Reply | null;
  busy: boolean;
  onReply: (r: Reply) => void;
  onAdd: () => void;
}) {
  const from = invite.organizer?.name || invite.organizer?.email;
  const answered = invite.answered;
  return (
    <section aria-label="Invitation" className="rounded-panel bg-trip px-5 pt-4 pb-5">
      <p className="text-meta font-medium text-ink-2">
        {answered ? `${answered.name} ${ANSWERED[answered.reply]}` : invite.cancelled ? "Cancelled" : from ? `Invitation from ${from}` : "Invitation"}
      </p>
      <div className="mt-3 flex items-center gap-5">
        <span className="flex w-14 shrink-0 flex-col items-center rounded-control bg-canvas py-1.5 shadow-[0_0_0_1px_var(--color-line)]">
          <span className="text-meta font-semibold tracking-wide text-trip-line uppercase">{month.format(invite.start)}</span>
          <span className="text-[24px] leading-7 font-semibold text-ink">{new Date(invite.start).getDate()}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-title font-semibold text-ink ${invite.cancelled ? "line-through" : ""}`}>{invite.title}</span>
          <span className="block text-body text-ink-2">{when(invite)}</span>
          <span className="block text-meta text-ink-3">
            {invite.guests > 0 && `${invite.guests} ${invite.guests === 1 ? "guest" : "guests"}`}
            {invite.guests > 0 && invite.join && " · "}
            {invite.join && (/meet\.google\.com/i.test(invite.join) ? "Google Meet" : /teams\.microsoft/i.test(invite.join) ? "Microsoft Teams" : "Video call")}
          </span>
        </span>
      </div>
      {!invite.cancelled && !answered && (
        <div className="mt-4 flex items-center gap-1">
          {invite.organizer && (
            <>
              <span className="mr-2 text-body text-ink-2">Going?</span>
              {(["yes", "maybe", "no"] as const).map((r) => (
                <Button key={r} variant={reply === r ? "primary" : "quiet"} disabled={busy} onClick={() => onReply(r)}>
                  {LABEL[r]}
                </Button>
              ))}
            </>
          )}
          <span className="flex-1" />
          {invite.join && (
            <Button onClick={() => void openLink(invite.join!)}>
              <Video size={13} strokeWidth={1.75} /> Join <ArrowUpRight size={12} strokeWidth={1.75} />
            </Button>
          )}
          <Button onClick={onAdd}>
            <CalendarPlus size={13} strokeWidth={1.75} /> Add to calendar
          </Button>
        </div>
      )}
    </section>
  );
}

/** The calendar file of a message, if it has one: text/calendar, or a .ics by name. */
const calendarOf = (files: DbAttachment[]) =>
  files.find((a) => a.mime_type?.toLowerCase().startsWith("text/calendar")) ?? files.find((a) => /\.ics$/i.test(a.filename ?? "") && a.gmail_attachment_id);

const fetched = new Map<string, Promise<string>>();

/** The .ics, fetched once per run through the account's provider (the same way an attachment opens). */
function icsOf(a: DbAttachment): Promise<string> {
  let p = fetched.get(a.id);
  if (!p) {
    p = getEmailProvider(a.account_id)
      .then((provider) => provider.fetchAttachment(a.message_id, a.gmail_attachment_id!))
      .then(({ data }) => new TextDecoder().decode(base64UrlToBytes(data)));
    p.catch(() => fetched.delete(a.id));
    fetched.set(a.id, p);
  }
  return p;
}

/** The answer sent from here, kept so the card shows it until the invitation itself says it. */
const replyKey = (inv: Invite, account: string) => `rsvp:${account}:${inv.uid}`;

export function InviteCardFor({ message, attachments, open }: CardProps) {
  const account = useAccountStore((s) => s.accounts.find((a) => a.id === message.account_id));
  const { show } = useToast();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const file = calendarOf(attachments);

  useEffect(() => {
    if (!open || !file?.gmail_attachment_id || !account) return;
    let live = true;
    void (async () => {
      const inv = readInvite(await icsOf(file), account.email);
      const sent = inv && ((await getSetting(replyKey(inv, account.id))) as Reply | null);
      if (!live) return;
      setInvite(inv);
      setReply(sent || inv?.reply || null);
    })().catch((err: unknown) => console.warn("invite read failed", err));
    return () => {
      live = false;
    };
  }, [open, file?.id, file?.gmail_attachment_id, account]);

  if (!invite || !account) return null;

  const answer = async (r: Reply) => {
    if (!invite.organizer || busy || r === reply) return;
    setBusy(true);
    try {
      const provider = await getEmailProvider(account.id);
      await provider.sendMessage(replyMail(invite, r, { name: account.displayName ?? "", email: account.email }));
      await setSetting(replyKey(invite, account.id), r);
      setReply(r);
      show(`Replied ${LABEL[r]}`);
    } catch (err) {
      console.error("voa invite reply failed:", err);
      show("Could not send the reply");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-4">
      <InviteCard
        invite={invite}
        reply={reply}
        busy={busy}
        onReply={(r) => void answer(r)}
        onAdd={() =>
          void icsOf(file!)
            .then((ics) => openIcs(`invite-${message.id}`, ics))
            .catch((err: unknown) => console.warn("add to calendar failed", err))
        }
      />
    </div>
  );
}
