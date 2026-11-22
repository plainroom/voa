import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Ban,
  Heart,
  Image,
  KeyRound,
  LifeBuoy,
  Mail,
  NotebookPen,
  PenLine,
  Tag,
  Signature,
  SunMoon,
  type LucideIcon,
} from "lucide-react";
import { deleteAccount } from "@/services/db/accounts";
import {
  getSecureSetting,
  getSetting,
  setSecureSetting,
  setSetting,
} from "@/services/db/settings";
import { removeClient } from "@/services/gmail/tokenManager";
import { removeGraphClient } from "@/services/graph/tokenManager";
import { useAccountStore } from "@/stores/accountStore";
import {
  listBlockedSenders,
  type BlockedSenderRow,
} from "@/services/db/blockedSenders";
import { BLOCK_IMAGES_SETTING, inboxSource } from "../inbox/source";
import { useReconnect } from "../accounts/useReconnect";
import { AI_NOTE, ownInstructions } from "../ai/apple";
import {
  DEFAULT_SIGNATURE,
  getSignature,
  SIGNATURE,
} from "../compose/signature";
import {
  WRITING_LEARN,
  WRITING_NOTE,
  writingSettings,
} from "../ai/tasks/write";
import { DEFAULT_OFF, KINDS, LABELS_OFF, labelsOff } from "../ai/tasks/labels";
import {
  APPEARANCE,
  applyAppearance,
  useAppearance,
  type Appearance,
} from "./appearance";
import { AppearancePicker } from "./AppearancePicker";
import { openSponsors, SupportPanel } from "./SupportPanel";
import {
  Button,
  Checkbox,
  IconButton,
  LabelTag,
  SaveButton,
  TextArea,
  TextField,
  useToast,
} from "../ui";

/** Settings, a page per topic from the sidebar: appearance, accounts, images, blocked senders, Apple Intelligence, sign-in clients. Esc goes back. */
type Page =
  | "appearance"
  | "accounts"
  | "signature"
  | "images"
  | "blocked"
  | "summary"
  | "labels"
  | "writing"
  | "clients"
  | "support";

const TITLE: Record<Page, string> = {
  appearance: "Appearance",
  accounts: "Accounts",
  signature: "Signature",
  images: "Images",
  blocked: "Blocked senders",
  summary: "Summary",
  labels: "Labels",
  writing: "Writing",
  clients: "Sign-in clients",
  support: "Support",
};

/** The sidebar, by topic. An item without a page is one coming next (Soon). */
const GROUPS: {
  title: string;
  items: {
    label: string;
    icon: LucideIcon;
    page?: Page;
    onSelect?: () => void;
    iconColor?: string;
  }[];
}[] = [
  {
    title: "General",
    items: [{ label: "Appearance", icon: SunMoon, page: "appearance" }],
  },
  {
    title: "Mail",
    items: [
      { label: "Accounts", icon: Mail, page: "accounts" },
      { label: "Signature", icon: Signature, page: "signature" },
      { label: "Images", icon: Image, page: "images" },
      { label: "Blocked senders", icon: Ban, page: "blocked" },
    ],
  },
  {
    title: "Apple Intelligence",
    items: [
      { label: "Summary", icon: NotebookPen, page: "summary" },
      { label: "Labels", icon: Tag, page: "labels" },
      { label: "Writing", icon: PenLine, page: "writing" },
    ],
  },
  {
    title: "Advanced",
    items: [{ label: "Sign-in clients", icon: KeyRound, page: "clients" }],
  },
  {
    title: "Help",
    items: [
      { label: "Support", icon: LifeBuoy, page: "support" },
      {
        label: "Buy me a coffee",
        icon: Heart,
        onSelect: openSponsors,
        iconColor: "#d1476a",
      },
    ],
  },
];

export function SettingsScreen() {
  const navigate = useNavigate();
  const { show } = useToast();
  const accounts = useAccountStore((s) => s.accounts).filter(
    (a) => a.provider !== "caldav",
  );
  const removeFromStore = useAccountStore((s) => s.removeAccount);
  const [confirming, setConfirming] = useState<string | null>(null);
  const { busy, reconnect } = useReconnect();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [microsoftClientId, setMicrosoftClientId] = useState("");
  const [blockImages, setBlockImages] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [signature, setSignature] = useState(DEFAULT_SIGNATURE);
  const [learn, setLearn] = useState(true);
  const [writingNote, setWritingNote] = useState("");
  const [page, setPage] = useState<Page>("accounts");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set(DEFAULT_OFF));
  const appearance = useAppearance();
  const [blocked, setBlocked] = useState<BlockedSenderRow[]>([]);
  // What each Save last wrote: a Save is off while its field still says the same.
  const [saved, setSaved] = useState<Record<string, string>>({});
  const changed = (key: string, value: string) =>
    value.trim() !== (saved[key] ?? "");
  const keep = (key: string, value: string) =>
    setSaved((s) => ({ ...s, [key]: value.trim() }));

  const back = () => void navigate({ to: "/" });

  useEffect(() => {
    let current = true;
    void (async () => {
      const [id, secret, microsoft, block, people, note] = await Promise.all([
        getSetting("google_client_id"),
        getSecureSetting("google_client_secret"),
        getSetting("microsoft_client_id"),
        getSetting(BLOCK_IMAGES_SETTING),
        listBlockedSenders().catch(() => [] as BlockedSenderRow[]),
        ownInstructions(),
      ]);
      if (!current) return;
      setClientId(id ?? "");
      setClientSecret(secret ?? "");
      setMicrosoftClientId(microsoft ?? "");
      setBlockImages(block === "true");
      setBlocked(people);
      setAiNote(note ?? "");
      const sig = await getSignature();
      setSignature(sig);
      const writing = await writingSettings();
      setLearn(writing.learn);
      setWritingNote(writing.note);
      setSaved({
        signature: sig.trim(),
        aiNote: (note ?? "").trim(),
        writing: writing.note,
        google: `${id ?? ""}\n${secret ?? ""}`.trim(),
        microsoft: (microsoft ?? "").trim(),
      });
      setOff(await labelsOff());
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]'))
        back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      removeClient(id);
      removeGraphClient(id);
      await deleteAccount(id);
      removeFromStore(id);
      window.dispatchEvent(new Event("voa-sync-done"));
      show("Account removed");
    } catch (err) {
      console.error("voa remove account failed:", err);
      show("Could not remove the account");
    }
  };

  const unblock = async (accountId: string, address: string) => {
    try {
      await inboxSource().unblock(accountId, address);
      setBlocked((rows) =>
        rows.filter(
          (row) => row.account_id !== accountId || row.address !== address,
        ),
      );
      show("Unblocked");
    } catch (err) {
      console.error("voa unblock failed:", err);
      show("Could not unblock");
    }
  };

  const toggleBlockImages = async (block: boolean) => {
    setBlockImages(block);
    try {
      await setSetting(BLOCK_IMAGES_SETTING, String(block));
    } catch (err) {
      console.error("voa save image setting failed:", err);
      setBlockImages(!block);
      show("Could not save");
    }
  };

  const chooseAppearance = async (a: Appearance) => {
    const before = appearance;
    applyAppearance(a);
    try {
      await setSetting(APPEARANCE, a);
    } catch (err) {
      console.error("voa save appearance failed:", err);
      applyAppearance(before);
      show("Could not save");
    }
  };

  const toggleLabel = async (id: string, on: boolean) => {
    const before = off;
    const next = new Set(off);
    if (on) next.delete(id);
    else next.add(id);
    setOff(next);
    try {
      await setSetting(LABELS_OFF, JSON.stringify([...next]));
      window.dispatchEvent(new Event("voa-labels"));
    } catch (err) {
      console.error("voa save labels failed:", err);
      setOff(before);
      show("Could not save");
    }
  };

  const saveLearn = async (on: boolean) => {
    setLearn(on);
    try {
      await setSetting(WRITING_LEARN, String(on));
    } catch (err) {
      console.error("voa save writing learn failed:", err);
      setLearn(!on);
      show("Could not save");
    }
  };

  /** Every Save here: writes the field, which then is what was saved (its Save turns off), and says how it went. */
  const save = async (
    key: string,
    value: string,
    write: () => Promise<unknown>,
  ) => {
    try {
      await write();
      keep(key, value);
      show("Saved");
    } catch (err) {
      console.error(`voa save ${key} failed:`, err);
      show("Could not save");
    }
  };

  const saveClient = async () => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret)
      return show("Both the client ID and the secret are needed");
    await save("google", `${id}\n${secret}`, async () => {
      await setSetting("google_client_id", id);
      await setSecureSetting("google_client_secret", secret);
    });
  };

  const saveMicrosoftClient = async () => {
    const id = microsoftClientId.trim();
    if (!id) return show("The Microsoft client ID is needed");
    await save("microsoft", id, () => setSetting("microsoft_client_id", id));
  };

  const pages: Record<Page, ReactNode> = {
    appearance: (
      <>
        <p className="pb-5 text-body text-ink-3">
          System follows your Mac; Light and Dark stay as they are.
        </p>
        <AppearancePicker
          value={appearance}
          onChange={(a) => void chooseAppearance(a)}
        />
      </>
    ),
    accounts: (
      <>
        <div className="flex justify-end pb-2">
          <Button
            onClick={() => window.dispatchEvent(new Event("voa-add-account"))}
          >
            Add account
          </Button>
        </div>
        {accounts.length === 0 && (
          <p className="py-2 text-body text-ink-3">No accounts yet.</p>
        )}
        <ul>
          {accounts.map((a) => {
            const service = accountService(a.provider);
            return (
              <li
                key={a.id}
                className="flex min-h-11 items-center gap-3 border-b border-line py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body text-ink">
                    {a.displayName || a.email}
                  </div>
                  <div className="truncate text-meta text-ink-3">
                    {a.displayName ? `${a.email} · ` : ""}
                    {service.name}
                  </div>
                </div>
                {confirming === a.id ? (
                  <>
                    <span className="text-meta text-ink-3">
                      Remove it and its mail from this computer? Its snoozed
                      emails stay archived in Gmail.
                    </span>
                    <Button onClick={() => void remove(a.id)}>Remove</Button>
                    <Button onClick={() => setConfirming(null)}>Keep</Button>
                  </>
                ) : (
                  <>
                    {service.reconnect && (
                      <Button
                        disabled={busy === a.id}
                        onClick={() => void reconnect(a.id)}
                      >
                        {busy === a.id
                          ? `Waiting for ${service.reconnect}`
                          : "Reconnect"}
                      </Button>
                    )}
                    <Button
                      aria-label={`Remove ${a.email}`}
                      onClick={() => setConfirming(a.id)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </>
    ),
    signature: (
      <>
        <p className="pb-3 text-body text-ink-3">
          Added after every email you send, replies included. Leave it empty for
          none.
        </p>
        <TextArea
          aria-label="Signature"
          rows={4}
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
        />
        <div className="pt-4">
          {/* Empty is kept as empty (no signature); only a setting never written falls back to the default. */}
          <SaveButton
            changed={changed("signature", signature)}
            onSave={() =>
              save("signature", signature, () =>
                setSetting(SIGNATURE, signature.trim()),
              )
            }
          />
        </div>
      </>
    ),
    images: (
      <>
        <Checkbox
          checked={blockImages}
          onChange={(e) => void toggleBlockImages(e.target.checked)}
        >
          Block remote images
        </Checkbox>
        <p className="pt-1 text-meta text-ink-3">
          Senders can tell when you open an email that loads its images. When
          blocked, an email asks before loading them, or always loads them from
          a sender you choose.
        </p>
      </>
    ),
    blocked: (
      <>
        {blocked.length === 0 ? (
          <p className="py-2 text-body text-ink-3">No blocked senders.</p>
        ) : (
          <ul>
            {blocked.map((row) => {
              const account = accounts.find(
                (item) => item.id === row.account_id,
              );
              return (
                <li
                  key={`${row.account_id}:${row.address}`}
                  className="flex min-h-11 items-center gap-3 border-b border-line py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body text-ink">
                      {row.address}
                    </div>
                    {account && (
                      <div className="truncate text-meta text-ink-3">
                        {account.email}
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={() => void unblock(row.account_id, row.address)}
                  >
                    Unblock
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </>
    ),
    summary: (
      <>
        <p className="pb-3 text-body text-ink-3">
          How Summarize (I) sums up a conversation for you: the language, the
          length, what matters to you.
        </p>
        <TextArea
          aria-label="How to summarize"
          value={aiNote}
          onChange={(e) => setAiNote(e.target.value)}
          placeholder="Always summarize in Brazilian Portuguese."
        />
        <div className="pt-4">
          <SaveButton
            changed={changed("aiNote", aiNote)}
            onSave={() =>
              save("aiNote", aiNote, () => setSetting(AI_NOTE, aiNote.trim()))
            }
          />
        </div>
      </>
    ),
    labels: (
      <>
        <p className="pb-3 text-body text-ink-3">
          New mail is labeled on this Mac as it arrives. Labels stay in voa:
          nothing changes in Gmail or Outlook.
        </p>
        <ul>
          {[
            {
              id: "respond",
              help: "A person asks you for a reply, a decision or an action",
            },
            ...KINDS,
          ].map((k) => (
            <li key={k.id} className="border-b border-line py-1.5">
              <Checkbox
                checked={!off.has(k.id)}
                onChange={(e) => void toggleLabel(k.id, e.target.checked)}
              >
                <span className="w-28 shrink-0">
                  <LabelTag name={k.id} />
                </span>
                <span className="text-ink-2">{k.help}</span>
              </Checkbox>
            </li>
          ))}
        </ul>
      </>
    ),
    writing: (
      <>
        <p className="pb-3 text-body text-ink-3">
          Write with Claude (⌘J) writes and changes your emails with your own
          Claude Code: it sends Claude the draft, your request and, in a reply,
          the conversation, with a few replies you sent and what you write here,
          for your voice.
        </p>
        <Checkbox
          checked={learn}
          onChange={(e) => void saveLearn(e.target.checked)}
        >
          Learn from the replies I sent
        </Checkbox>
        <div className="pt-3">
          <TextArea
            aria-label="How you write"
            rows={4}
            value={writingNote}
            onChange={(e) => setWritingNote(e.target.value)}
            placeholder="Short and direct. In Portuguese, I open with “Oi, tudo bem?”."
          />
        </div>
        <div className="pt-4">
          <SaveButton
            changed={changed("writing", writingNote)}
            onSave={() =>
              save("writing", writingNote, () =>
                setSetting(WRITING_NOTE, writingNote.trim()),
              )
            }
          />
        </div>
      </>
    ),
    support: <SupportPanel />,
    clients: (
      <div className="flex flex-col gap-10">
        <section aria-label="Google client">
          <h3 className="flex h-8 items-center text-meta font-medium text-ink-3">
            Google
          </h3>

          <p className="pb-3 text-body text-ink-3">
            Gmail sign-in needs your own OAuth client (a Desktop app one). The
            steps are in docs/google-client.md. IMAP accounts do not need it.
          </p>
          <div className="flex flex-col gap-1">
            <TextField
              aria-label="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID (….apps.googleusercontent.com)"
            />
            <TextField
              aria-label="Client secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Client secret"
            />
          </div>
          <div className="pt-4">
            <SaveButton
              changed={changed(
                "google",
                `${clientId.trim()}\n${clientSecret.trim()}`,
              )}
              onSave={saveClient}
            />
          </div>
        </section>
        <section aria-label="Microsoft client">
          <h3 className="flex h-8 items-center text-meta font-medium text-ink-3">
            Microsoft
          </h3>

          <p className="pb-3 text-body text-ink-3">
            Outlook and Hotmail sign-in needs the Application (client) ID of
            your own Azure app. It is a public client: there is no secret.
            Register the redirect http://localhost:17248.
          </p>
          <TextField
            aria-label="Microsoft client ID"
            value={microsoftClientId}
            onChange={(e) => setMicrosoftClientId(e.target.value)}
            placeholder="Application (client) ID"
          />
          <div className="pt-4">
            <SaveButton
              changed={changed("microsoft", microsoftClientId)}
              onSave={saveMicrosoftClient}
            />
          </div>
        </section>
      </div>
    ),
  };

  return (
    <div className="flex h-screen bg-canvas text-ink">
      <aside
        data-tauri-drag-region
        className="flex w-60 shrink-0 flex-col border-r border-line px-4 pt-9 select-none"
      >
        <div data-tauri-drag-region className="flex h-9 items-center gap-2">
          <IconButton label="Back" keys="Esc" onClick={back}>
            <ArrowLeft size={15} strokeWidth={1.75} />
          </IconButton>
          <h1 className="text-title font-semibold">Settings</h1>
        </div>
        <nav aria-label="Settings" className="overflow-y-auto pb-6">
          {GROUPS.map((g) => (
            <div key={g.title} className="mt-5">
              <p className="px-2 pb-1 text-meta font-medium text-ink-3">
                {g.title}
              </p>
              {g.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={!item.page && !item.onSelect}
                  aria-current={item.page === page ? "page" : undefined}
                  onClick={() =>
                    item.page ? setPage(item.page) : item.onSelect?.()
                  }
                  className={`flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-body transition-colors duration-(--vm-fast) ${
                    item.page === page
                      ? "bg-selected font-medium text-ink"
                      : "text-ink-2 hover:bg-hover hover:text-ink"
                  } disabled:pointer-events-none disabled:opacity-50`}
                >
                  <item.icon
                    size={14}
                    strokeWidth={1.75}
                    className="shrink-0 text-ink-3"
                    style={
                      item.iconColor ? { color: item.iconColor } : undefined
                    }
                  />
                  <span className="flex-1">{item.label}</span>
                  {!item.page && !item.onSelect && (
                    <span className="rounded-full border border-line px-1.5 text-[10px] leading-4">
                      Soon
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-[640px] px-10 pt-[76px] pb-24">
          <h2 className="pb-4 text-display font-semibold">{TITLE[page]}</h2>
          {pages[page]}
        </div>
      </main>
    </div>
  );
}

function accountService(provider?: string): {
  name: string;
  reconnect: "Google" | "Microsoft" | null;
} {
  if (provider === "graph") return { name: "Outlook", reconnect: "Microsoft" };
  if (provider === "imap") return { name: "IMAP", reconnect: null };
  return { name: "Gmail", reconnect: "Google" };
}
