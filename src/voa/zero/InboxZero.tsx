import { openUrl } from "@tauri-apps/plugin-opener";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Empty } from "../ui";
import { credit, photoOfDay } from "./photos";
import type { ZeroState } from "./zeroState";

const dateLine = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

const open = (url: string) => void openUrl(url).catch(() => window.open(url, "_blank", "noopener"));

// Today's photo is decoded when the app starts and kept, so it is on screen the frame the inbox empties, never a dark frame first.
// ponytail: the day the app started; a window left open past midnight decodes tomorrow's on its first show.
const decoded = new Image();
decoded.src = photoOfDay(new Date()).src;
void decoded.decode().catch(() => {});

// The swap holds until the app restarts, so an inbox that fills and empties again keeps the photo chosen.
let swapped = 0;

/** The reward: the window becomes one photo (behind the top bar, which stays), "All clear." and a small line under it. */
function Photo({ now, starred, onStarred }: { now: Date; starred: number; onStarred: () => void }) {
  const [skip, setSkip] = useState(swapped);
  const photo = photoOfDay(now, skip);
  return (
    <div className="absolute inset-0 bg-neutral-900 text-white select-none">
      <img src={photo.src} alt="" className="absolute inset-0 size-full object-cover" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-linear-to-b from-black/35 to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[45%] bg-linear-to-t from-black/50 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 px-8 pb-8">
        <div>
          <div className="text-display font-semibold">All clear.</div>
          <div className="pt-1 text-body text-white/85">
            {starred > 0 && (
              <>
                <button type="button" onClick={onStarred} className="cursor-default underline-offset-2 hover:underline focus-visible:underline">
                  {starred} starred to follow up
                </button>
                {" · "}
              </>
            )}
            {dateLine.format(now)}
          </div>
        </div>
        <div className="flex items-center gap-2 text-meta text-white/60">
          <button type="button" onClick={() => open(photo.url)} className="cursor-default transition-colors duration-(--vm-fast) hover:text-white/90">
            {credit(photo)}
          </button>
          <button
            type="button"
            aria-label="Another photo"
            title="Another photo"
            onClick={() => setSkip((swapped = skip + 1))}
            className="cursor-default transition-colors duration-(--vm-fast) hover:text-white/90"
          >
            <RefreshCw size={12} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the inbox shows when it has nothing: the photo, or a quiet line when only the filtered account is empty. */
export function InboxZero({
  state,
  accountName,
  starred,
  onStarred,
  now,
}: {
  state: ZeroState;
  /** The account the quiet line is about. */
  accountName: string;
  starred: number;
  onStarred: () => void;
  now: Date;
}) {
  if (state === "allClear") return <Photo now={now} starred={starred} onStarred={onStarred} />;
  return <Empty title={`${accountName} is clear`} />;
}
