import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

const onMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Cmd+F on a Mac (Ctrl+F elsewhere): the platform's own find key, never the other modifier. `/` opens search from the list too. */
export function isSearchHotkey(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  mac = onMac(),
): boolean {
  const modifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return modifier && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";
}

/** A reply or a draft being written keeps the key: search takes it from anywhere else, its own field included. */
function writingElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target.dataset.searchField !== undefined) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.closest("[contenteditable='true']") !== null;
}

export function useSearchHotkey(): void {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchHotkey(e) || writingElsewhere(e.target)) return;
      e.preventDefault();
      if (!pathname.endsWith("/search")) void navigate({ to: "/search", search: { q: "" } });
      window.dispatchEvent(new Event("voa-focus-search"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, pathname]);
}
