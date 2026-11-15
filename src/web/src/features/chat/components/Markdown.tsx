import { memo, type ReactNode, useLayoutEffect, useRef } from "react";
import { observeResize } from "@/lib/observe-resize";
import { cn } from "@/lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { prepareMath } from "../lib/math";
import { citationOf, holdPartialCitation, markCitations } from "../lib/study-cite";
import { ACTIONS_FENCE } from "../lib/chat-actions";
import { STUDY_FENCE } from "../lib/study-chat";
import { CodeBlock } from "./CodeBlock";
import { CitationChip } from "./CitationChip";
import { ChatActions } from "./ChatActions";
import { LatexBlock } from "./LatexBlock";
import { MermaidBlock } from "./MermaidBlock";
import { StudyBlock } from "./StudyBlock";

/**
 * Assistant prose. Long words break, wide things (code, tables, display
 * math) scroll inside their own frame (docs/UI-REBUILD.md › Overflow).
 */

type Ctx = { space: string; streaming: boolean; messageKey: string };

const KATEX_OPTIONS = { throwOnError: false, strict: "ignore", errorColor: "var(--error-foreground)" } as const;

/**
 * KaTeX breaks inline math only after relations and operators, so one
 * unbreakable piece (a long \text{}, an inline matrix, a formula that
 * failed and shows its source) can be wider than the message and push the
 * whole conversation sideways. Those few get `katex-wide`: their own
 * sideways scroll, like display math. Rechecked when the text or width changes.
 */
function useWideMath(source: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !source.includes("$")) return;
    const check = () => {
      const width = box.clientWidth;
      for (const k of box.querySelectorAll<HTMLElement>(".katex")) {
        if (k.parentElement?.closest(".katex-display")) continue;
        k.classList.remove("katex-wide");
        if (k.getBoundingClientRect().width > width + 4) k.classList.add("katex-wide");
      }
    };
    check();
    return observeResize(box, check);
  }, [source]);
  return ref;
}

function makeComponents(ctx: Ctx): Components {
  return {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, node }) => {
      const text = String(children ?? "").replace(/\n$/, "");
      const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
      const block = node?.position && node.position.start.line !== node.position.end.line;
      if (!lang && !block) return <code className="md-inline-code">{children}</code>;
      if (lang === "mermaid") return <MermaidBlock code={text} streaming={ctx.streaming} />;
      if (lang === "latex" || lang === "tex") return <LatexBlock source={text} space={ctx.space} streaming={ctx.streaming} />;
      if (lang === STUDY_FENCE) return <StudyBlock code={text} space={ctx.space} streaming={ctx.streaming} messageKey={ctx.messageKey} />;
      if (lang === ACTIONS_FENCE) return <ChatActions code={text} space={ctx.space} />;
      return <CodeBlock code={text} lang={lang} />;
    },
    a: ({ href, children }) => {
      const cite = citationOf(href);
      if (cite) return <CitationChip space={ctx.space} citation={cite} />;
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" className="md-link">
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    ),
    img: ({ src, alt }) => (typeof src === "string" ? <img src={src} alt={alt ?? ""} className="max-h-96 rounded-lg border" loading="lazy" /> : null),
  };
}

export const Markdown = memo(function Markdown({
  text,
  space,
  streaming = false,
  messageKey,
  inline = false,
  className,
}: {
  text: string;
  space: string;
  streaming?: boolean;
  messageKey: string;
  /** Short text (a question, an option): no paragraph margins, wraps like a span. */
  inline?: boolean;
  className?: string;
}): ReactNode {
  const source = markCitations(prepareMath(streaming ? holdPartialCitation(text) : text, streaming));
  const components = makeComponents({ space, streaming, messageKey });
  if (inline) components.p = ({ children }) => <span>{children}</span>;
  const ref = useWideMath(source);
  return (
    <div ref={ref} className={cn("markdown", inline && "markdown-inline", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]} rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
