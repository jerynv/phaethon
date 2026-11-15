import { useEffect, useId, useState } from "react";
import { RowError } from "@/components/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeBlock } from "./CodeBlock";

let mermaid: Promise<typeof import("mermaid")> | null = null;

/** A diagram drawn once its code has finished arriving; its source stays one click away if it can't be drawn. */
export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    if (streaming) return;
    let live = true;
    mermaid ??= import("mermaid");
    void mermaid
      .then(async ({ default: m }) => {
        m.initialize({ startOnLoad: false, theme: document.documentElement.classList.contains("dark") ? "dark" : "neutral", fontFamily: "Inter Variable, sans-serif", securityLevel: "strict" });
        const out = await m.render(`m${id}`, code);
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
  if (!svg) return <Skeleton className="my-3 h-40 w-full rounded-lg" />;
  return (
    <figure className="group/mermaid relative my-3 overflow-x-auto rounded-lg border bg-card p-4">
      <div className="flex justify-center [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <button type="button" onClick={() => setShowSource(true)} className="absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/mermaid:opacity-100">
        Source
      </button>
    </figure>
  );
}
