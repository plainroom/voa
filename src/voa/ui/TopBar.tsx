import type { MouseEvent, ReactNode } from "react";
import { AccountDot } from "./AccountDot";

export interface TopBarTab {
  id: string;
  label: string;
  count: number;
  dotColor?: string | null;
  active: boolean;
}

/** One tab: the active one is dark, the others light grey. The count shows only when not zero. */
function Tab({ label, count, dotColor, active, onClick }: Omit<TopBarTab, "id"> & { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-baseline text-title transition-colors duration-(--vm-fast) ${
        active ? "font-semibold text-ink" : "text-ink-3 hover:text-ink-2"
      }`}
    >
      {dotColor && (
        <span className="mr-2 self-center">
          <AccountDot color={dotColor} />
        </span>
      )}
      {label}
      {count > 0 && <span className="ml-1.5 text-meta font-normal text-ink-3 tabular-nums">{count}</span>}
    </button>
  );
}

/**
 * The only chrome: tabs on the left, a couple of icons on the right. The empty strip above is
 * the window's drag area and room for the macOS traffic lights.
 */
export function TopBar({
  tabs,
  onTab,
  right,
  note,
  onRestClick,
}: {
  tabs: TopBarTab[];
  onTab: (id: string) => void;
  right?: ReactNode;
  /** A quiet status, such as Offline, or one thing to do, such as Reconnect. It never replaces the list. */
  note?: ReactNode;
  /** A click on the empty bar: the drag strip and the gaps, never a tab or an icon. */
  onRestClick?: () => void;
}) {
  const rest = (e: MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) onRestClick?.();
  };
  return (
    <header data-tauri-drag-region onClick={rest} className="shrink-0 px-8 pt-9 pb-1 select-none">
      <div data-tauri-drag-region onClick={rest} className="flex h-9 items-center gap-6">
        {tabs.map((t) => (
          <Tab key={t.id} label={t.label} count={t.count} dotColor={t.dotColor} active={t.active} onClick={() => onTab(t.id)} />
        ))}
        <div data-tauri-drag-region className="flex-1" onClick={onRestClick} />
        {note && <span className={`text-meta text-ink-3 ${typeof note === "string" ? "pointer-events-none" : ""}`}>{note}</span>}
        {right && (
          <div onClick={rest} className="-mr-1.5 flex items-center gap-1">
            {right}
          </div>
        )}
      </div>
    </header>
  );
}
