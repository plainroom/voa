import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import "./styles/globals.css";
import { noContextMenu } from "./voa/ui/contextMenu";

noContextMenu(document);

// The webview's warnings and errors also go to the app's log file (~/Library/Logs/email.voa): a release build has no console.
const logText = (a: unknown) => {
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return typeof a === "string" ? a : JSON.stringify(a);
  } catch {
    return String(a);
  }
};
if ("__TAURI_INTERNALS__" in window) {
  for (const [name, level] of [["warn", 4], ["error", 5]] as const) {
    const original = console[name];
    console[name] = (...args: unknown[]) => {
      original(...args);
      void invoke("plugin:log|log", { level, message: args.map(logText).join(" ") }).catch(() => {});
    };
  }
}

const params = new URLSearchParams(window.location.search);
async function start() {
  // The in-memory demo inbox: dev builds and the website's build (mode "site", vite.site.config.ts) only, in a plain browser, with ?demo=1.
  if ((import.meta.env.DEV || import.meta.env.MODE === "site") && !("__TAURI_INTERNALS__" in window) && ["1", "zero", "notsyncing", "offline", "site"].includes(params.get("demo") ?? "")) {
    const [{ demoSource }, { setDemoSource }] = await Promise.all([import("./voa/demo/fixture"), import("./voa/inbox/source")]);
    setDemoSource(demoSource);
  }
  // The screens load after the demo is set: a screen that reads its data when it loads (inbox zero's photo) reads the demo's.
  const { router } = await import("./router");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

void start();
