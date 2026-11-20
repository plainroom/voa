import { Fragment, useEffect, useState } from "react";
import { Languages } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DbMessage } from "@/services/db/messages";
import { getSetting, setSetting } from "@/services/db/settings";
import {
  LANGUAGES,
  languageName,
  TRANSLATE_TO,
  translateMessage,
  type Translation,
} from "../ai/translate";
import { Picker, PickerLayer } from "../ui/Picker";

/** Where macOS downloads translation languages (General › Language & Region › Translation Languages). */
const LANGUAGE_SETTINGS =
  "x-apple.systempreferences:com.apple.Localization-Settings.extension";

/**
 * Translate (T): the conversation in the language picked the first time, kept as the default; T again shows the original.
 * Only this conversation, and only while it is open.
 */
export function useTranslate(messages: DbMessage[], conversation: string) {
  const [to, setTo] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [byMessage, setByMessage] = useState<Record<string, Translation>>({});

  useEffect(() => {
    setTo(null);
    setByMessage({});
  }, [conversation]);

  useEffect(() => {
    if (!to) return;
    let live = true;
    setByMessage({});
    void (async () => {
      for (const m of messages) {
        const t = await translateMessage(m, to).catch((err: unknown) => {
          console.warn("translate failed", err);
          return null;
        });
        if (!live) return;
        if (t) setByMessage((s) => ({ ...s, [m.id]: t }));
      }
    })();
    return () => {
      live = false;
    };
  }, [to, messages]);

  const pick = (lang: string) => {
    setChoosing(false);
    void setSetting(TRANSLATE_TO, lang);
    setTo(lang);
  };
  const toggle = async () => {
    if (to) return setTo(null);
    const lang = await getSetting(TRANSLATE_TO);
    if (lang) setTo(lang);
    else setChoosing(true);
  };

  const translated = (m: DbMessage) => {
    const t = byMessage[m.id];
    return t && !("why" in t) ? t : null;
  };

  const bar = to && (
    <TranslateBar
      to={to}
      messages={messages}
      byMessage={byMessage}
      onOriginal={() => setTo(null)}
      onChange={() => setChoosing(true)}
    />
  );
  const picker = choosing && (
    <PickerLayer onClose={() => setChoosing(false)}>
      <Picker
        items={LANGUAGES.map((l) => ({
          id: l,
          label: languageName(l),
          hint: l === to ? "Current" : undefined,
        }))}
        onPick={(c) => "id" in c && pick(c.id)}
        onClose={() => setChoosing(false)}
      />
    </PickerLayer>
  );
  return { translating: to !== null, toggle, translated, bar, picker };
}

function TranslateBar({
  to,
  messages,
  byMessage,
  onOriginal,
  onChange,
}: {
  to: string;
  messages: DbMessage[];
  byMessage: Record<string, Translation>;
  onOriginal: () => void;
  onChange: () => void;
}) {
  const results = messages
    .map((m) => byMessage[m.id])
    .filter((t): t is Translation => !!t);
  const from =
    results.find((t) => t.from && !("why" in t && t.why === "same"))?.from ??
    results[0]?.from ??
    null;
  const why = (w: string) => results.some((t) => "why" in t && t.why === w);
  const done = results.length === messages.length;
  const target = languageName(to);
  const source = from ? languageName(from) : null;

  const message = !done
    ? "Translating…"
    : why("download")
      ? `Download ${source && source !== target ? `${source} and ${target}` : target} in Language & Region › Translation Languages.`
      : results.every((t) => "why" in t && t.why === "same")
        ? `Already in ${target}.`
        : why("unsupported")
          ? `macOS cannot translate ${source ?? "this language"} to ${target}.`
          : why("unknown") && !results.some((t) => !("why" in t))
            ? "Could not tell this conversation's language."
            : `Translated${source ? ` from ${source}` : ""} to ${target}`;

  // What keeps the mail from being translated stands out: the user has something to do.
  const warning =
    done &&
    (why("download") ||
      why("unsupported") ||
      (why("unknown") && !results.some((t) => !("why" in t))));
  const actions = [
    ...(done && why("download")
      ? [{ label: "Open Settings", run: () => void openUrl(LANGUAGE_SETTINGS) }]
      : []),
    { label: "Show original", run: onOriginal },
    { label: "Change language", run: onChange },
  ];

  return (
    <div className="-mt-2 mb-4 text-meta">
      <p
        className={`flex items-center gap-1.5 ${warning ? "text-warning" : "text-ink-3"}`}
      >
        <Languages size={12} strokeWidth={1.75} />{" "}
        {message}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 pl-[18px] text-ink-3">
        {actions.map((a, i) => (
          <Fragment key={a.label}>
            {i > 0 && <span>·</span>}
            <button
              type="button"
              className="text-ink-2 hover:text-ink"
              onClick={a.run}
            >
              {a.label}
            </button>
          </Fragment>
        ))}
      </p>
    </div>
  );
}
