import { useEffect, useId, useState } from "react";

import { Icon } from "@/icons";

import { ShowSource, tokenHex, useThemeKey } from "./source";

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | null = null;
/** mermaid (MIT) is loaded only when a reply first has a diagram: it's large. */
const loadMermaid = () => (loading ??= import("mermaid").then((m) => m.default));

/** What kind of diagram the source is, in words: its first keyword. */
const KINDS: Record<string, string> = {
  graph: "Flowchart",
  flowchart: "Flowchart",
  sequenceDiagram: "Sequence diagram",
  classDiagram: "Class diagram",
  stateDiagram: "State diagram",
  "stateDiagram-v2": "State diagram",
  erDiagram: "Entity relationship diagram",
  gantt: "Gantt chart",
  pie: "Pie chart",
  journey: "User journey",
  mindmap: "Mind map",
  timeline: "Timeline",
  quadrantChart: "Quadrant chart",
  gitGraph: "Git graph",
  xychart: "Chart",
  "xychart-beta": "Chart",
  sankey: "Sankey diagram",
  "sankey-beta": "Sankey diagram",
  block: "Block diagram",
  "block-beta": "Block diagram",
  kanban: "Kanban board",
};

/** The diagram's name: its accTitle when the source gives one, else its kind. */
export function diagramName(code: string): string {
  const title = /^\s*accTitle\s*:\s*(.+)$/m.exec(code)?.[1]?.trim();
  if (title) return title;
  const first = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) ?? "";
  return KINDS[first.split(/\s/)[0]] ?? "Diagram";
}

let seq = 0;

/**
 * A ```mermaid fence drawn as a diagram: mermaid at its strictest (no
 * scripts, no links that run anything, labels sanitised), in the app's own
 * colours and reading font, redrawn when the theme changes. It is an image
 * named by its title or kind, with its source one fold below; one that
 * can't be drawn says so in plain words and shows its source.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const theme = useThemeKey();
  const [svg, setSvg] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const descId = useId();
  const name = diagramName(code);

  useEffect(() => {
    let stale = false;
    const id = `ph-mermaid-${++seq}`;
    setProblem("");
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const font = getComputedStyle(document.documentElement).getPropertyValue("--ph-font-sans").trim() || "sans-serif";
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          darkMode: theme === "dark",
          fontFamily: font,
          themeVariables: {
            darkMode: theme === "dark",
            fontFamily: font,
            fontSize: "15px",
            background: tokenHex("--ph-bg"),
            primaryColor: tokenHex("--ph-surface"),
            primaryTextColor: tokenHex("--ph-ink"),
            primaryBorderColor: tokenHex("--ph-line-strong"),
            secondaryColor: tokenHex("--ph-accent-soft"),
            secondaryTextColor: tokenHex("--ph-ink"),
            tertiaryColor: tokenHex("--ph-surface-sunken"),
            tertiaryTextColor: tokenHex("--ph-ink"),
            lineColor: tokenHex("--ph-ink-secondary"),
            textColor: tokenHex("--ph-ink"),
            mainBkg: tokenHex("--ph-surface"),
            nodeBorder: tokenHex("--ph-line-strong"),
            clusterBkg: tokenHex("--ph-surface-sunken"),
            edgeLabelBackground: tokenHex("--ph-bg"),
            noteBkgColor: tokenHex("--ph-warning-soft"),
            noteTextColor: tokenHex("--ph-ink"),
            actorBkg: tokenHex("--ph-surface"),
            actorBorder: tokenHex("--ph-line-strong"),
            actorTextColor: tokenHex("--ph-ink"),
            signalColor: tokenHex("--ph-ink-secondary"),
            signalTextColor: tokenHex("--ph-ink"),
          },
        });
        await mermaid.parse(code);
        const out = await mermaid.render(id, code);
        if (!stale) setSvg(out.svg);
      } catch (e) {
        if (!stale) {
          setSvg(null);
          const first = (e instanceof Error ? e.message : String(e)).split("\n").find((l) => l.trim()) ?? "";
          setProblem(first.slice(0, 200));
        }
      } finally {
        // mermaid leaves its scratch element behind when a diagram fails.
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
      }
    })();
    return () => {
      stale = true;
    };
  }, [code, theme]);

  return (
    <figure className="my-4 flex w-full flex-col items-start gap-1 first:mt-0" data-mermaid="">
      {problem ? (
        <p role="note" className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink-secondary" data-mermaid-problem="">
          <Icon name="warning" className="mt-0.5 shrink-0" />
          <span>
            This diagram couldn’t be drawn, so its source is shown instead.
            {problem && <span className="block text-ink-tertiary">{problem}</span>}
          </span>
        </p>
      ) : svg ? (
        <div
          role="img"
          aria-label={name}
          aria-describedby={descId}
          className="w-full overflow-x-auto rounded-lg border border-line bg-bg p-3"
          data-mermaid-figure=""
          // mermaid's own output at securityLevel "strict", sanitised by its DOMPurify.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="text-sm text-ink-secondary" role="status">
          Drawing the diagram…
        </p>
      )}
      {!problem && (
        <figcaption id={descId} className="sr-only">
          A {name === "Diagram" ? "diagram" : name}. Its source is in “Show the diagram’s source” below it.
        </figcaption>
      )}
      {problem ? <pre className="w-full overflow-auto rounded-md border border-line bg-surface-sunken p-3 font-mono text-sm whitespace-pre" tabIndex={0} aria-label="The diagram’s source"><code>{code}</code></pre> : <ShowSource code={code} what="diagram" />}
    </figure>
  );
}
