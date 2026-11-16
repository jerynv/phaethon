import { useEffect, useId, useState } from "react";
import { RowError } from "@/components/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeBlock } from "./CodeBlock";

let mermaid: Promise<typeof import("mermaid")> | null = null;
/** Drawn diagrams by theme and source: a conversation opened again shows them at once, at their size. */
const drawn = new Map<string, string>();
const themeOf = () => (document.documentElement.classList.contains("dark") ? "dark" : "neutral");

/**
 * Loads the diagram library ahead of the first diagram, while nothing else is
 * happening: loading it on demand takes long enough that a chat opening with
 * a diagram on its last screen would wait on it.
 */
export function warmMermaid(): () => void {
  if (mermaid) return () => {};
  // The library and its flowchart (the usual diagram), which it loads separately on first use.
  const load = () => {
    mermaid ??= import("mermaid");
    void mermaid.then(({ default: m }) => m.parse("flowchart LR\n  a --> b").catch(() => {})).catch(() => {});
  };
  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(load, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(load, 1500);
  return () => clearTimeout(t);
}

/** A diagram drawn once its code has finished arriving; its source stays one click away if it can't be drawn. */
export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(() => (streaming ? null : (drawn.get(`${themeOf()}\n${code}`) ?? null)));
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    if (streaming) return;
    const theme = themeOf();
    const key = `${theme}\n${code}`;
    const hit = drawn.get(key);
    if (hit) return setSvg(hit);
    let live = true;
    mermaid ??= import("mermaid");
    void mermaid
      .then(async ({ default: m }) => {
        m.initialize({ startOnLoad: false, theme, fontFamily: "Inter Variable, sans-serif", securityLevel: "strict" });
        const out = await m.render(`m${id}`, code);
        if (drawn.size > 100) drawn.clear();
        drawn.set(key, out.svg);
        if (live) setSvg(out.svg);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message.split("\n")[0]! : "The diagram has a mistake in it."));
    return () => {
      live = false;
    };
  }, [code, streaming, id]);
  if (error || showSource) {
    return (
      <div className="my-3 flex flex-col gap-1.5">
        {error ? <RowError message={`Couldn’t draw this diagram: ${error}`} /> : null}
        <CodeBlock code={code} lang="mermaid" />
      </div>
    );
  }
  if (!svg) return <Skeleton data-pending="" className="my-3 h-40 w-full rounded-lg" />;
  return (
    <figure className="group/mermaid relative my-3 overflow-x-auto rounded-lg border bg-card p-4">
      <div className="flex justify-center [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <button type="button" onClick={() => setShowSource(true)} className="absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/mermaid:opacity-100">
        Source
      </button>
    </figure>
  );
}
