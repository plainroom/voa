import { useEffect, useState } from "react";
import { getSetting } from "@/services/db/settings";
import { escapeHtml } from "@/utils/sanitize";

/** The settings row of the signature (Settings > Signature). Never set is the default; empty is none. */
export const SIGNATURE = "signature";
export const DEFAULT_SIGNATURE = "Sent with voa";

export async function getSignature(): Promise<string> {
  // A setting that cannot be read never holds a send back: it goes with the default.
  const v = await getSetting(SIGNATURE).catch(() => null);
  return v ?? DEFAULT_SIGNATURE;
}

/** The mail's HTML with the signature after a blank line; the HTML alone when there is none. */
export function withSignature(html: string, signature: string): string {
  const text = signature.trim();
  if (!text) return html;
  return `${html}<br><div class="voa-signature">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

/** The signature, for showing under what is being written (what goes out is read again on send). */
export function useSignature(): string {
  const [text, setText] = useState("");
  useEffect(() => {
    let live = true;
    getSignature()
      .then((s) => live && setText(s.trim()))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return text;
}

/** The signature in grey under the editor: it is not editable there, Settings > Signature is where it changes. */
export function SignaturePreview({ text }: { text: string }) {
  return text ? <p className="pb-2 text-body whitespace-pre-line text-ink-3">{text}</p> : null;
}
