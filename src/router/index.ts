import { createRouter, createHashHistory } from "@tanstack/react-router";
import { noteOpenThread } from "@/voa/compose/draftStash";
import { routeTree } from "./routeTree";

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
  defaultPreload: false,
});

// Compose's From defaults to the account of the conversation last open.
router.subscribe("onResolved", ({ toLocation }) => {
  const m = /^\/t\/([^/]+)\//.exec(toLocation.pathname);
  if (m) noteOpenThread(decodeURIComponent(m[1]!));
});

// Type-safe router module augmentation
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
