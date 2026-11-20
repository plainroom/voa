import { useState } from "react";
import { inboxSource } from "../inbox/source";
import { useToast } from "../ui/Toast";

/** Signs an account in again (the provider's own page opens), and says how it went. `busy` is the account waiting for it. */
export function useReconnect() {
  const { show } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const reconnect = async (id: string) => {
    setBusy(id);
    try {
      await inboxSource().reconnect(id);
      show("Reconnected");
    } catch (err) {
      console.error("voa reconnect failed:", err);
      show(err instanceof Error ? err.message : "Could not reconnect");
    } finally {
      setBusy(null);
    }
  };
  return { busy, reconnect };
}
