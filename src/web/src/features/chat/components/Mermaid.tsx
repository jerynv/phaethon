import { ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { CodeBlock } from "./CodeBlock";

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | null = null;
const loadMermaid = () => (loading ??= import("mermaid").then((m) => m.default));

const isDark = () => document.documentElement.classList.contains("dark");

/**
 * A ```mermaid diagram, drawn once the reply is whole (mermaid loads on first
 * use, in strict mode). The source stays one disclosure away, and a diagram
 * that can't be drawn shows its source instead.
 */
export function Mermaid({ code, streaming, label = "Diagram" }: { code: string; streaming: boolean; label?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"drawing" | "drawn" | "failed">("drawing");
  useEffect(() => {
    if (streaming) return;
    let live = true;
    setState("drawing");
    void loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark() ? "dark" : "neutral",
          fontFamily: "inherit",
          themeVariables: { fontSize: "15px" },
        });
        const { svg } = await mermaid.render(`m${id}${Date.now().toString(36)}`, code);
        if (!live || !box.current) return;
        box.current.innerHTML = svg;
        box.current.querySelector("svg")?.setAttribute("aria-hidden", "true");
        setState("drawn");
      })
      .catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [code, streaming, id]);

  if (state === "failed") {
    return (
      <div className="ph-block ph-ui flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">This diagram couldn’t be drawn, so here is its source.</p>
        <CodeBlock code={code} lang="mermaid" streaming={false} />
      </div>
    );
  }
  return (
    <figure className="ph-block ph-ui m-0 flex flex-col gap-1.5" data-mermaid="">
      <div role="img" aria-label={label} className="min-h-16 overflow-x-auto rounded-lg border bg-background p-3" data-state={state}>
        {state === "drawing" && <div className="h-24 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />}
        {/* Filled by mermaid, never by React. */}
        <div ref={box} className="ph-mermaid" />
      </div>
      <details className="group text-sm text-muted-foreground">
        <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-sm marker:content-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          Diagram source
        </summary>
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{code}</pre>
      </details>
    </figure>
  );
}
