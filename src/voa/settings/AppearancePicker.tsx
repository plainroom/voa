import type { Appearance } from "./appearance";

const LABEL: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

/** A hint of the app in one scheme, drawn with its own tokens: the canvas, a title, three lines. */
function Preview({ scheme }: { scheme: "light" | "dark" }) {
  return (
    <span className={`scheme-${scheme} absolute inset-0 bg-canvas px-4 pt-4`}>
      <span className="block h-1.5 w-8 rounded-full bg-ink" />
      <span className="mt-3 block h-1 w-[86%] rounded-full bg-ink-3/60" />
      <span className="mt-2 block h-1 w-[72%] rounded-full bg-ink-3/60" />
      <span className="mt-2 block h-1 w-[80%] rounded-full bg-ink-3/60" />
    </span>
  );
}

/** System, Light, Dark, each shown as the app would look; System is half of each. */
export function AppearancePicker({ value, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
  return (
    <div role="radiogroup" aria-label="Appearance" className="flex gap-4">
      {(["system", "light", "dark"] as const).map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          onClick={() => onChange(a)}
          className="group flex flex-col items-center gap-2 outline-none"
        >
          <span
            className={`relative block h-[72px] w-[112px] overflow-hidden rounded-panel transition-shadow duration-(--vm-fast) group-focus-visible:shadow-[0_0_0_2px_var(--color-accent)] ${
              value === a ? "shadow-[0_0_0_2px_var(--color-accent)]" : "shadow-[0_0_0_1px_var(--color-line)] group-hover:shadow-[0_0_0_1px_var(--color-ink-3)]"
            }`}
          >
            {a === "system" ? (
              <>
                <Preview scheme="light" />
                <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                  <Preview scheme="dark" />
                </span>
              </>
            ) : (
              <Preview scheme={a} />
            )}
          </span>
          <span className={`text-body transition-colors duration-(--vm-fast) ${value === a ? "text-ink" : "text-ink-3 group-hover:text-ink-2"}`}>
            {LABEL[a]}
          </span>
        </button>
      ))}
    </div>
  );
}
