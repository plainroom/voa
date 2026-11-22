import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stashDraft } from "../compose/draftStash";
import { Button } from "../ui";

/** Where feedback and contact messages go: the address on the site, read by the team. */
export const SUPPORT_EMAIL = "hi@voa.email";
/** Bugs are issues on the repository, with its bug template. */
export const BUG_URL =
  "https://github.com/plainroom/voa/issues/new?template=bug_report.yml";
export const SPONSORS_URL = "https://github.com/sponsors/pseudonym-dev";

const openOutside = (url: string) =>
  void openUrl(url).catch(() => window.open(url, "_blank", "noopener"));

/** The sidebar's Buy me a coffee: GitHub Sponsors, in the browser. */
export const openSponsors = () => openOutside(SPONSORS_URL);

/** Settings › Support. A bug opens its issue on GitHub; feedback and contact open voa's own compose, to the team. */
export function SupportPanel() {
  const navigate = useNavigate();
  const write = (subject: string) => {
    stashDraft({ accountId: null, to: [SUPPORT_EMAIL], subject, html: "" });
    void navigate({ to: "/compose" });
  };

  return (
    <>
      <ul>
        <Row
          title="Report a bug"
          text="Open an issue on GitHub with what you did and what happened."
          button="Report a bug"
          onClick={() => openOutside(BUG_URL)}
        />
        <Row
          title="Send feedback"
          text="An idea, a complaint or a thank you."
          button="Send feedback"
          onClick={() => write("voa feedback")}
        />
        <Row
          title="Contact us"
          text={`Write to ${SUPPORT_EMAIL} from inside voa.`}
          button="Contact us"
          onClick={() => write("")}
        />
      </ul>
    </>
  );
}

function Row({
  title,
  text,
  button,
  onClick,
}: {
  title: string;
  text: string;
  button: string;
  onClick: () => void;
}) {
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-line py-2">
      <div className="min-w-0 flex-1">
        <div className="text-body text-ink">{title}</div>
        <div className="text-meta text-ink-3">{text}</div>
      </div>
      <Button onClick={onClick}>{button}</Button>
    </li>
  );
}
