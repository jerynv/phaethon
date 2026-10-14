import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Details } from "@/components/ui/details";
import { cn } from "@/lib/utils";

/** Source text as a block that scrolls sideways (and takes focus to, by keyboard). */
export function SourceBlock({ code, label, className }: { code: string; label: string; className?: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className={cn(
        "max-h-(--ph-figure-max-height) w-full overflow-auto rounded-md border border-line bg-surface-sunken p-3 font-mono text-sm leading-normal whitespace-pre text-ink",
        className,
      )}
    >
      <code>{code}</code>
    </pre>
  );
}

/** "Show the source" folded under a diagram, a figure or a document. */
export function ShowSource({ code, what, children }: { code: string; what: string; children?: ReactNode }) {
  return (
    <Details summary={`Show the ${what}’s source`} className="w-full [&>div]:w-full">
      {children}
      <SourceBlock code={code} label={`The ${what}’s source`} />
    </Details>
  );
}

/** Bumps whenever the theme (light, dark) changes, for drawings that take their colours from tokens. */
export function useThemeKey(): string {
  const read = useCallback(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"), []);
  const [key, setKey] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setKey(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => watch.disconnect();
  }, [read]);
  return key;
}

/** A token's colour as #rrggbb, for libraries that can't read oklch (mermaid's colour maths). */
export function tokenHex(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
