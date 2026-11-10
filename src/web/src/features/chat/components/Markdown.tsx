import "katex/dist/katex.min.css";
import "../chat.css";

import { memo, use, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import katex from "katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { useNav } from "@/app/nav";
import { cn } from "@/lib/utils";
import { spacePathOf } from "../../viewer/kinds";
import { LinkBaseContext, useSpaceId } from "../context";
import { ACTIONS_FENCE } from "../lib/chat-actions";
import { prepareMath } from "../lib/math";
import { STUDY_FENCE } from "../lib/study-chat";
import { citationOf, holdPartialCitation, markCitations } from "../lib/study-cite";
import { ActionButtons } from "./ActionButtons";
import { CitationChip } from "./CitationChip";
import { CodeBlock } from "./CodeBlock";
import { Mermaid } from "./Mermaid";
import { StudyCard } from "./StudyCard";

/**
 * KaTeX as Phaethon uses it: a formula it can't read shows its source
 * instead of throwing; no \href or \includegraphics; bounded expansion.
 * MathML stays beside the drawing so screen readers read the formula.
 */
const KATEX = {
  throwOnError: false,
  errorColor: "var(--destructive)",
  strict: "ignore",
  trust: false,
  output: "htmlAndMathml",
  maxExpand: 500,
  maxSize: 40,
} as const;

const mathCache = new Map<string, string>();
function renderMath(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = mathCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { ...KATEX, displayMode: display });
    mathCache.set(key, html);
    if (mathCache.size > 2000) mathCache.clear();
  }
  return html;
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const textOf = (n: HastNode | undefined): string => (!n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

function FencedBlock({ lang, code, streaming }: { lang: string; code: string; streaming: boolean }) {
  if (lang === ACTIONS_FENCE) return <ActionButtons code={code} />;
  if (lang === STUDY_FENCE) return <StudyCard code={code} />;
  if (lang === "mermaid") return <Mermaid code={code} streaming={streaming} />;
  return <CodeBlock code={code} lang={lang} streaming={streaming} />;
}

function SpaceLink({ path, children }: { path: string; children: ReactNode }) {
  const space = useSpaceId();
  const openFile = useNav((s) => s.openFile);
  return (
    <a
      href={path}
      onClick={(e) => {
        e.preventDefault();
        openFile(path, space);
      }}
      data-space-link=""
    >
      {children}
    </a>
  );
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const base = use(LinkBaseContext);
  const cite = citationOf(href);
  if (cite) return <CitationChip path={cite.path} quote={cite.quote} />;
  const path = spacePathOf(href, base);
  if (path) return <SpaceLink path={path}>{children}</SpaceLink>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}

function components(streaming: boolean, headingShift: number): Components {
  const heading =
    (level: number) =>
    ({ children }: { children?: ReactNode }) => {
      const shifted = Math.min(6, level + headingShift);
      const Tag = `h${shifted}` as "h3";
      return <Tag data-level={level}>{children}</Tag>;
    };
  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    pre({ node, children }) {
      const code = (node as HastNode | undefined)?.children?.[0];
      if (code?.type === "element" && code.tagName === "code") {
        const cls = (code.properties?.className as string[] | undefined) ?? [];
        const lang = cls.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
        if (cls.includes("math-display")) {
          // Wide display math gets a box of its own that scrolls sideways and takes focus.
          return (
            <div className="ph-block ph-math-display" tabIndex={0} role="group" aria-label="Formula" dangerouslySetInnerHTML={{ __html: renderMath(textOf(code), true) }} />
          );
        }
        return <FencedBlock lang={lang} code={textOf(code).replace(/\n$/, "")} streaming={streaming} />;
      }
      return <pre>{children}</pre>;
    },
    a({ href, children }) {
      return <MdLink href={href}>{children}</MdLink>;
    },
    code({ node, className, children }) {
      if (className?.includes("math-inline")) {
        return <span dangerouslySetInnerHTML={{ __html: renderMath(textOf(node as HastNode), false) }} />;
      }
      return <code className={className}>{children}</code>;
    },
    table({ children }) {
      return (
        <div className="ph-block overflow-x-auto" tabIndex={0} role="region" aria-label="Table">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const REMARK = [remarkGfm, remarkMath];

/**
 * Markdown as Phaethon draws it: GitHub-flavoured, KaTeX math, mermaid,
 * highlighted code with Copy, citation chips, space-file links, and the
 * reply-only blocks (buttons, a study card). Headings are shifted under the
 * message's own heading so screen-reader heading navigation stays in order.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  headingShift = 2,
  inline = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  headingShift?: number;
  /** Phrasing only (inside a heading or a label): paragraphs become spans. */
  inline?: boolean;
  className?: string;
}) {
  const source = markCitations(prepareMath(streaming ? holdPartialCitation(text) : text, streaming));
  const parts = components(streaming, headingShift);
  if (inline) {
    parts.p = ({ children }) => <span className="block">{children}</span>;
    return (
      <span className={cn("ph-md block", className)}>
        <ReactMarkdown remarkPlugins={REMARK} components={parts}>
          {source}
        </ReactMarkdown>
      </span>
    );
  }
  return (
    <div className={cn("ph-md", className)}>
      <ReactMarkdown remarkPlugins={REMARK} components={parts}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
