import { Check, Clock, PenLine, Search, Star } from "lucide-react";
import { ACCOUNT_COLORS } from "../accounts/accountColors";
import { AccountDot } from "./AccountDot";
import { AttachmentChip } from "./AttachmentChip";
import { Button, IconButton } from "./Button";
import { GroupHeader } from "./GroupHeader";
import { Picker } from "./Picker";
import { Row, RowAction } from "./Row";
import { Checkbox } from "./Checkbox";
import { TextField } from "./TextField";
import { Toast } from "./Toast";
import { TopBar } from "./TopBar";

const noop = () => {};

const ROWS = [
  {
    group: "Today",
    color: "account-2",
    from: "Marina Costa",
    subject: "Revised proposal",
    preview:
      "Hi, here is the version with the changes we talked about on Monday",
    date: "10:42",
    unread: true,
  },
  {
    group: "Today",
    color: "account-1",
    from: "Banco Inter",
    subject: "Your statement is ready",
    preview: "Your November statement is available in the app",
    date: "09:15",
    unread: true,
  },
  {
    group: "Today",
    color: "account-2",
    from: "Rafael Lima",
    subject: "Thursday meeting",
    preview: "Can we move it to 3pm? Something came up in the morning",
    date: "08:03",
    unread: false,
  },
  {
    group: "Yesterday",
    color: "account-1",
    from: "Ana Dutra",
    subject: "Trip photos",
    preview:
      "Put everything in the shared folder, the ones from the beach are great",
    date: "Tue",
    unread: false,
  },
  {
    group: "Yesterday",
    color: "account-2",
    from: "GitHub",
    subject: "PR approved",
    preview: "Your pull request #214 was approved by lucasprado",
    date: "Tue",
    unread: false,
  },
];

const actions = (
  <>
    <RowAction label="Done" onClick={noop}>
      <Check size={14} strokeWidth={1.75} />
    </RowAction>
    <RowAction label="Star" onClick={noop}>
      <Star size={14} strokeWidth={1.75} />
    </RowAction>
    <RowAction label="Remind me" onClick={noop}>
      <Clock size={14} strokeWidth={1.75} />
    </RowAction>
  </>
);

function Label({ children }: { children: string }) {
  return (
    <div className="px-8 pt-10 pb-3 text-meta font-medium tracking-wide text-ink-3 uppercase">
      {children}
    </div>
  );
}

function Panel({ scheme }: { scheme: "light" | "dark" }) {
  let lastGroup = "";
  return (
    <section
      className={`${scheme === "dark" ? "scheme-dark" : "scheme-light"} min-w-0 flex-1 bg-canvas pb-16 text-ink`}
    >
      <TopBar
        tabs={[
          { id: "all", label: "Inbox", count: 7, active: true },
          {
            id: "p",
            label: "Personal",
            count: 3,
            dotColor: "account-1",
            active: false,
          },
          {
            id: "w",
            label: "Work",
            count: 4,
            dotColor: "account-2",
            active: false,
          },
        ]}
        onTab={noop}
        right={
          <>
            <IconButton label="Compose">
              <PenLine size={15} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Search">
              <Search size={15} strokeWidth={1.75} />
            </IconButton>
          </>
        }
      />
      {ROWS.map((r, i) => {
        const header =
          r.group !== lastGroup ? <GroupHeader label={r.group} /> : null;
        lastGroup = r.group;
        return (
          <div key={i}>
            {header}
            <Row
              dotColor={r.color}
              from={r.from}
              subject={r.subject}
              preview={r.preview}
              date={r.date}
              unread={r.unread}
              selected={i === 0}
              onOpen={noop}
              actions={actions}
            />
          </div>
        );
      })}

      <Label>Attachment</Label>
      <div className="flex gap-2 px-8">
        <AttachmentChip name="Proposal v3.pdf" size={482_113} onOpen={noop} />
        <AttachmentChip name="photo.jpg" size={2_310_400} onOpen={noop} />
      </div>

      <Label>Toast</Label>
      <div className="px-8">
        <div className="inline-block">
          <Toast message="Done" onUndo={noop} />
        </div>
      </div>

      <Label>Picker</Label>
      <div className="px-8">
        <Picker
          items={[
            { id: "tonight", label: "Tonight", hint: "6:00 PM" },
            { id: "tomorrow", label: "Tomorrow morning", hint: "Thu 8:00 AM" },
            { id: "weekend", label: "This weekend", hint: "Sat 9:00 AM" },
            { id: "next-week", label: "Next week", hint: "Mon 8:00 AM" },
          ]}
          freeText={{
            placeholder: "Or type a time: friday 2pm",
            parse: () => null,
          }}
          onPick={noop}
        />
      </div>

      <Label>Buttons and field</Label>
      <div className="flex items-center gap-3 px-8">
        <Button variant="primary">Send</Button>
        <Button>Discard</Button>
      </div>
      <div className="max-w-80 px-8 pt-4">
        <TextField placeholder="Search all accounts" />
      </div>
      <div className="px-8 pt-4">
        <Checkbox>Block remote images</Checkbox>
      </div>

      <Label>Accounts</Label>
      <div className="flex items-center gap-4 px-8">
        {ACCOUNT_COLORS.map((c) => (
          <span
            key={c}
            className="inline-flex items-center gap-2 text-meta text-ink-3"
          >
            <AccountDot color={c} />
            {c}
          </span>
        ))}
      </div>

      <Label>Type</Label>
      <div className="space-y-2 px-8">
        <div className="text-display font-semibold">All clear.</div>
        <div className="text-title font-semibold">Inbox</div>
        <div className="text-body">Marina Costa · Revised proposal</div>
        <div className="text-body text-ink-2">
          Secondary: a read conversation
        </div>
        <div className="text-meta text-ink-3">Tertiary: Today · 10:42</div>
      </div>
    </section>
  );
}

/** Every primitive, light and dark side by side (route /ds). */
export function Showcase() {
  return (
    <div className="flex h-screen overflow-auto">
      <Panel scheme="light" />
      <Panel scheme="dark" />
    </div>
  );
}
