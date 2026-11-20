import { createRootRoute, createRoute } from "@tanstack/react-router";
import App from "@/App";
import { ComposeScreen } from "@/voa/compose/ComposeScreen";
import { SettingsScreen } from "@/voa/settings/SettingsScreen";
import { SearchScreen } from "@/voa/search/SearchScreen";
import { InboxScreen } from "@/voa/inbox/InboxScreen";
import { ThreadScreen } from "@/voa/thread/ThreadScreen";
import { Showcase } from "@/voa/ui/Showcase";

// ---------- Root (shell: overlays) ----------
const rootRoute = createRootRoute({
  component: App,
});

// ---------- voa: the unified lists, the reading screen, the design system page ----------
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <InboxScreen list="INBOX" />,
});

const starredRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "starred",
  component: () => <InboxScreen list="STARRED" />,
});

const snoozedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "snoozed",
  component: () => <InboxScreen list="SNOOZED" />,
});

const spamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "spam",
  component: () => <InboxScreen list="SPAM" />,
});

const trashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "trash",
  component: () => <InboxScreen list="TRASH" />,
});

const doneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "done",
  component: () => <InboxScreen list="DONE" />,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "t/$accountId/$threadId",
  component: ThreadScreen,
});

const composeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "compose",
  component: ComposeScreen,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "search",
  validateSearch: (search: Record<string, unknown>): { q: string } => ({ q: typeof search["q"] === "string" ? search["q"] : "" }),
  component: function SearchRoute() {
    const { q } = searchRoute.useSearch();
    return <SearchScreen q={q} />;
  },
});

const dsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "ds",
  component: Showcase,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: SettingsScreen,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  starredRoute,
  snoozedRoute,
  spamRoute,
  trashRoute,
  doneRoute,
  threadRoute,
  composeRoute,
  searchRoute,
  settingsRoute,
  dsRoute,
]);
