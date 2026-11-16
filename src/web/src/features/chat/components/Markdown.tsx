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
import { linkTarget, looksLikeFilePath } from "../lib/links";
import { FileChip, copyText } from "@/components/file-chip";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
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

/** The smallest a display formula shrinks to fit its message before it scrolls instead. */
const MATH_FIT_MIN = 0.7;

/** Marks which sides of a sideways scroller have more past them (`data-more-start` / `data-more-end`), for the edge fade. */
function markMore(el: HTMLElement) {
  const more = el.scrollWidth - el.clientWidth;
  el.toggleAttribute("data-more-start", more > 1 && el.scrollLeft > 1);
  el.toggleAttribute("data-more-end", more > 1 && el.scrollLeft < more - 1);
}

/**
 * Math wider than the message, rechecked when the text or width changes.
 *
 * KaTeX breaks inline math only after relations and operators, so one
 * unbreakable piece (a long \text{}, an inline matrix, a formula that
 * failed and shows its source) can be wider than the message and push the
 * whole conversation sideways. Those few get `katex-wide`: their own
 * sideways scroll.
 *
 * A display formula wider than the message (a matrix in a narrow window)
 * shrinks to fit, down to `MATH_FIT_MIN`; past that it scrolls, and the
 * edge with more of it past fades out.
 *
 * A message the browser is skipping off screen (`render-near-view`) is left
 * alone, since measuring it would lay it out, and checked when it comes near.
 */
function useWideMath(source: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !source.includes("$")) return;
    const check = () => {
      const width = box.clientWidth;
      // Not laid out (a hidden page), or skipped off screen: leave it as it was until it is shown.
      if (width === 0 || !box.checkVisibility({ contentVisibilityAuto: true })) return;
      const katex = [...box.querySelectorAll<HTMLElement>(".katex")];
      const inline = katex.filter((k) => !k.parentElement?.closest(".katex-display"));
      const displays = [...box.querySelectorAll<HTMLElement>(".katex-display")];
      if (inline.length === 0 && displays.length === 0) return;
      // All writes, then all reads, then all writes: one layout for the message, not one per formula.
      for (const k of inline) k.classList.remove("katex-wide");
      const wide = inline.map((k) => k.getBoundingClientRect().width > width + 4);
      // A formula is a row of base boxes (`katex-base`; `base` before KaTeX 0.19); its width at the current size, and that size, give the width it needs at full size.
      const fits = displays.map((d) => {
        const bases = d.querySelectorAll<HTMLElement>(".katex-html > :is(.katex-base, .base)");
        if (bases.length === 0) return 1;
        const drawn = bases[bases.length - 1]!.getBoundingClientRect().right - bases[0]!.getBoundingClientRect().left;
        const scale = Number(d.dataset.fit ?? 1);
        const room = d.clientWidth - 8; // its 4 px side padding
        return Math.max(MATH_FIT_MIN, Math.min(1, room / (drawn / scale)));
      });
      inline.forEach((k, i) => wide[i] && k.classList.add("katex-wide"));
      displays.forEach((d, i) => {
        const fit = Math.floor(fits[i]! * 100) / 100;
        if (fit === Number(d.dataset.fit ?? 1)) return;
        if (fit === 1) {
          delete d.dataset.fit;
          d.style.removeProperty("font-size");
        } else {
          d.dataset.fit = String(fit);
          d.style.fontSize = `${fit}em`;
        }
      });
      for (const d of displays) markMore(d);
    };
    check();
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.classList.contains("katex-display")) markMore(t);
    };
    const msg = box.closest<HTMLElement>(".render-near-view");
    const onNear = (e: Event) => {
      if (!(e as ContentVisibilityAutoStateChangeEvent).skipped) check();
    };
    box.addEventListener("scroll", onScroll, { capture: true, passive: true });
    msg?.addEventListener("contentvisibilityautostatechange", onNear);
    const stop = observeResize(box, check);
    return () => {
      stop();
      box.removeEventListener("scroll", onScroll, { capture: true });
      msg?.removeEventListener("contentvisibilityautostatechange", onNear);
    };
  }, [source]);
  return ref;
}

/** A web or mail link: opens in the browser (the desktop shell routes `_blank` there); right-click copies it. */
function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<a href={url} target="_blank" rel="noreferrer noopener" className="md-link" title={url} />}>{children}</ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onClick={() => window.open(url, "_blank", "noopener")}>
          <Icon icon={icons.external} />
          Open in browser
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyText(url, "Link copied")}>
          <Icon icon={icons.copy} />
          Copy link
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

function makeComponents(ctx: Ctx): Components {
  return {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, node }) => {
      const text = String(children ?? "").replace(/\n$/, "");
      const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
      const block = node?.position && node.position.start.line !== node.position.end.line;
      if (!lang && !block) {
        if (looksLikeFilePath(text)) return <FileChip space={ctx.space} path={text.trim()} variant="inline" label={<code>{text.trim()}</code>} />;
        return <code className="md-inline-code">{children}</code>;
      }
      if (lang === "mermaid") return <MermaidBlock code={text} streaming={ctx.streaming} />;
      if (lang === "latex" || lang === "tex") return <LatexBlock source={text} space={ctx.space} streaming={ctx.streaming} />;
      if (lang === STUDY_FENCE) return <StudyBlock code={text} space={ctx.space} streaming={ctx.streaming} messageKey={ctx.messageKey} />;
      if (lang === ACTIONS_FENCE) return <ChatActions code={text} space={ctx.space} />;
      return <CodeBlock code={text} lang={lang} />;
    },
    a: ({ href, children }) => {
      const cite = citationOf(href);
      if (cite) return <CitationChip space={ctx.space} citation={cite} />;
      const target = linkTarget(href);
      if (target.kind === "file") return <FileChip space={ctx.space} path={target.path} variant="inline" label={children} />;
      if (target.kind !== "external") return <span className="md-link">{children}</span>;
      return <ExternalLink url={target.url}>{children}</ExternalLink>;
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
