import { Paperclip } from "lucide-react";

/** "820 B", "14.2 KB", "3.1 MB". */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One attached file under a message: its name and size. Clicking opens it. */
export function AttachmentChip({ name, size, busy = false, onOpen }: { name: string; size: number | null; busy?: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      title={`Open ${name}`}
      className="inline-flex h-7 max-w-[280px] items-center gap-1.5 rounded-control border border-line px-2.5 text-body text-ink-2 transition-colors duration-(--vm-fast) hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
    >
      <Paperclip size={12} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate">{name}</span>
      {size != null && <span className="shrink-0 text-meta text-ink-3 tabular-nums">{formatFileSize(size)}</span>}
    </button>
  );
}
