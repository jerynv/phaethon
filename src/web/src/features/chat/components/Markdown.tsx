import { memo, type ReactNode } from "react";
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

export const Markdown = memo(function Markdown({ text, space, streaming = false, messageKey }: { text: string; space: string; streaming?: boolean; messageKey: string }): ReactNode {
  const source = markCitations(prepareMath(streaming ? holdPartialCitation(text) : text, streaming));
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]} components={makeComponents({ space, streaming, messageKey })}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
