"use client";

// Adapted from the assistant-ui registry (MIT): restyled with Phaethon tokens.

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
  memoizeMarkdownComponents,
  type SyntaxHighlighterProps,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type ComponentProps,
  createContext,
  type CSSProperties,
  type FC,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TextMessagePartProps, useAuiState } from "@assistant-ui/react";

import { SpaceIdContext } from "@/components/chat/approval-card";
import { useAnnounce } from "@/components/chat/announce";
import { CitationChip } from "@/components/rich/citation";
import { LatexDocumentCard, TikzFigure } from "@/components/rich/latex-block";
import { MATH_REHYPE, MATH_REMARK, prepareMath } from "@/components/rich/math";
import { MermaidDiagram } from "@/components/rich/mermaid-diagram";
import { SpaceFileLink, useLinkBase } from "@/components/viewer/file-viewer";
import { Button } from "@/components/ui/button";
import { setCodeWrap, useCodeWrap } from "@/hooks/use-code-wrap";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "@/icons";
import { spacePathOf } from "@/lib/files";
import { isLatexDocument } from "@/lib/latex";
import { citationOf, markCitations } from "@/lib/study-cite";
import { cn } from "@/lib/utils";

import { SyntaxHighlighter } from "./syntax-highlighter";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
  componentsByLanguage?: MarkdownTextPrimitiveProps["componentsByLanguage"];
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(value: T): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

/**
 * A single line break in what someone typed stays a line break (markdown
 * would otherwise run the lines together). For the user's own messages.
 */
type MdNode = { type: string; value?: string; children?: MdNode[] };
function remarkSoftBreaks() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value?.includes("\n")) {
        child.value.split("\n").forEach((piece, i) => {
          if (i > 0) next.push({ type: "break" });
          if (piece) next.push({ type: "text", value: piece });
        });
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

/**
 * Heading levels without gaps, for screen-reader navigation: the levels a
 * reply uses are ranked (a reply of "##" and "####" becomes levels 1 and 2),
 * so under the message's own h2 they render as h3, h4 and never jump. The
 * written level is kept in `data-md-depth`, so each still looks as written.
 */
type HeadingNode = MdNode & { depth?: number; data?: { hProperties?: Record<string, unknown> } };
function remarkHeadingLevels() {
  return (tree: MdNode) => {
    const heads: HeadingNode[] = [];
    const walk = (n: HeadingNode) => {
      if (n.type === "heading") heads.push(n);
      n.children?.forEach(walk);
    };
    walk(tree);
    const depths = [...new Set(heads.map((h) => h.depth ?? 1))].sort((a, b) => a - b);
    for (const h of heads) {
      const written = h.depth ?? 1;
      h.data = { ...h.data, hProperties: { ...h.data?.hProperties, "data-md-depth": written } };
      h.depth = depths.indexOf(written) + 1;
    }
  };
}

const ASSISTANT_PLUGINS = [remarkGfm, ...MATH_REMARK, remarkHeadingLevels];
const USER_PLUGINS = [remarkGfm, ...MATH_REMARK, remarkSoftBreaks, remarkHeadingLevels];

/**
 * The text markdown is being drawn from (after prepareMath), so a fence can
 * tell whether it is closed yet: a diagram, document or figure is drawn only
 * once its fence is, and shows as code while it streams in.
 */
const FenceSourceContext = createContext<{ current: string } | null>(null);

/** Whether a fenced block's markdown (from its opening fence on) ends with its closing fence. */
export function fenceClosed(raw: string): boolean {
  const lines = raw.replace(/\s+$/, "").split("\n");
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
  if (!open || lines.length < 2) return false;
  const close = lines[lines.length - 1].trim();
  return close.length >= open[1].length && [...close].every((c) => c === open[1][0]);
}

type Positioned = { position?: { start?: { offset?: number }; end?: { offset?: number } } };
/** Whether the fenced block at `node` is complete (always, outside a streaming message). */
function useFenceClosed(node: Positioned | undefined): boolean {
  const source = useContext(FenceSourceContext);
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (!source || start === undefined || end === undefined) return true;
  return fenceClosed(source.current.slice(start, end));
}

const MarkdownTextImpl: FC<MarkdownTextProps & { user?: boolean }> = ({ components, componentsByLanguage, user }) => {
  const stableComponents = useShallowStable(components);
  const stableComponentsByLanguage = useShallowStable(componentsByLanguage);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return { ...defaultComponents, ...memoizeMarkdownComponents(stableComponents) };
  }, [stableComponents]);
  const byLanguage = useMemo(() => ({ ...RICH_FENCES, ...stableComponentsByLanguage }), [stableComponentsByLanguage]);
  // While the reply streams, a half-written $$ block is held back rather than drawn half-made.
  const streaming = useAuiState((s) => s.message.status?.type === "running");
  const [source] = useState(() => ({ current: "" }));
  const preprocess = useCallback(
    (text: string) => {
      // A reply's [source: … "…"] citations become chips checked against the files (not in the person's own words).
      const out = prepareMath(user ? text : markCitations(text), streaming);
      source.current = out;
      return out;
    },
    [streaming, source, user],
  );

  return (
    <FenceSourceContext.Provider value={source}>
      <MarkdownTextPrimitive
        remarkPlugins={user ? USER_PLUGINS : ASSISTANT_PLUGINS}
        rehypePlugins={MATH_REHYPE}
        preprocess={preprocess}
        className={cn("aui-md text-md text-ink", user ? "max-w-full" : "max-w-(--ph-measure)")}
        components={markdownComponents}
        componentsByLanguage={byLanguage}
        // Text shows as it arrives, with no typing effect: Copy and "Phaethon
        // replied" then never come before the last words are on screen (C15).
        smooth={false}
        defer
      />
    </FenceSourceContext.Provider>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

/** The user's own message: the same markdown, with typed line breaks kept. */
export const UserMarkdownText = memo((props: MarkdownTextProps) => <MarkdownTextImpl {...props} user />);

/**
 * Markdown outside a message (the approval card's preview of a file, the
 * file viewer, study cards): the same look, with math, diagrams, LaTeX
 * documents and figures; no streaming and no syntax colours. Links to files
 * open the viewer where a space is known (SpaceIdContext).
 */
export function RichMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("aui-md text-md text-ink", className)} data-rich="">
      <ReactMarkdown remarkPlugins={ASSISTANT_PLUGINS} rehypePlugins={MATH_REHYPE} components={staticComponents}>
        {prepareMath(markCitations(text))}
      </ReactMarkdown>
    </div>
  );
}

/** The approval card's name for the same renderer. */
export const StaticMarkdown = RichMarkdown;

/** The bar above a code block: its language, Wrap lines and Copy (which says when it worked). */
const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard({ copiedDuration: 2000 });
  const announce = useAnnounce();
  const wrap = useCodeWrap();
  const was = useRef(false);
  useEffect(() => {
    if (isCopied && !was.current) announce("Code copied.");
    was.current = isCopied;
  }, [isCopied, announce]);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-2 rounded-t-lg border border-b-0 border-line bg-surface py-1 ps-3 pe-1">
      <span className="font-mono text-xs text-ink-secondary">{language || "text"}</span>
      <span className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={wrap}
          data-code-wrap=""
          className="text-ink-secondary hover:text-ink"
          onClick={() => {
            setCodeWrap(!wrap);
            announce(wrap ? "Long lines scroll sideways." : "Long lines wrap.");
          }}
        >
          {wrap && <Icon name="check" className="size-(--ph-icon-size-sm)" />}
          Wrap lines
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-ink-secondary hover:text-ink"
          onClick={() => code && !isCopied && copyToClipboard(code)}
        >
          <Icon name={isCopied ? "check" : "copy"} className="size-(--ph-icon-size-sm)" />
          {/* Says what it copies, on screen too, so voice control and sight agree ("Copy code"). */}
          <span>{isCopied ? "Copied" : "Copy code"}</span>
        </Button>
      </span>
    </div>
  );
};

/**
 * A wide table's scroll cue: a soft shadow at an edge while there is more
 * table past it (covers in the page colour scroll with the content, "local",
 * and hide the shadows at the ends). When the table is wider than the reply,
 * a line above it says so in words and offers to wrap it to fit instead.
 */
const EDGE = "color-mix(in oklch, var(--ph-ink) 16%, transparent)";
const SCROLL_SHADOWS: CSSProperties = {
  background: [
    "linear-gradient(to right, var(--ph-bg) 30%, transparent) left center / 2.5rem 100% no-repeat local",
    "linear-gradient(to left, var(--ph-bg) 30%, transparent) right center / 2.5rem 100% no-repeat local",
    `linear-gradient(to right, ${EDGE}, transparent) left center / 0.875rem 100% no-repeat scroll`,
    `linear-gradient(to left, ${EDGE}, transparent) right center / 0.875rem 100% no-repeat scroll`,
  ].join(", "),
};

function Table({ className, ...props }: ComponentProps<"table">) {
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [wrap, setWrap] = useState(false);
  const hintId = useId();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWide(el.scrollWidth > el.clientWidth + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    if (el.firstElementChild) watch.observe(el.firstElementChild);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="my-4 flex max-w-full flex-col gap-1" data-md-table="">
      {(wide || wrap) && (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-secondary" data-table-cue="">
          <span id={hintId}>
            {wrap
              ? wide
                ? "Wrapped between words, and still wider than the reply: scroll sideways for the rest."
                : "Wrapped to fit."
              : "Wider than the reply: scroll sideways to see it all."}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={wrap}
            data-table-wrap=""
            onClick={() => setWrap(!wrap)}
          >
            {wrap ? "Scroll instead" : "Wrap to fit"}
          </Button>
        </p>
      )}
      <div
        ref={box}
        className="w-fit max-w-full overflow-x-auto rounded-lg border border-line"
        style={SCROLL_SHADOWS}
        tabIndex={0}
        role="group"
        aria-label="Table"
        aria-describedby={wide ? hintId : undefined}
      >
        <table
          className={cn(
            "border-collapse text-base",
            // Wrapped between words (hyphenated where the language allows), never mid-word;
            // only long unbroken tokens (code, links) may break anywhere.
            wrap &&
              "[&_a]:wrap-anywhere [&_code]:wrap-anywhere [&_td]:break-words [&_td]:hyphens-auto [&_th]:break-words [&_th]:hyphens-auto",
            className,
          )}
          {...props}
        />
      </div>
    </div>
  );
}

/** Code inside a block, or `inline code`. */
function Code({ className, style, ...props }: ComponentProps<"code">) {
  const isCodeBlock = useIsMarkdownCodeBlock();
  // In a block, the code follows "Wrap lines" itself: it is memoised on its
  // markdown node, so a changed style from the highlighter would not reach it.
  const wrap = useCodeWrap();
  return (
    <code
      className={cn(!isCodeBlock && "rounded-xs border border-line bg-surface px-1 py-px font-mono text-sm", className)}
      style={isCodeBlock ? { ...style, whiteSpace: wrap ? "pre-wrap" : "pre" } : style}
      {...props}
    />
  );
}

/** A code block: wraps long lines or scrolls sideways, as chosen with "Wrap lines". */
function Pre({ className, style, ...props }: ComponentProps<"pre">) {
  const wrap = useCodeWrap();
  return (
    <pre
      tabIndex={0}
      data-wrap={wrap ? "on" : "off"}
      className={cn(
        "rounded-b-lg border border-line bg-surface-sunken p-3 font-mono text-sm leading-normal tracking-normal",
        wrap ? "whitespace-pre-wrap wrap-anywhere" : "overflow-x-auto whitespace-pre",
        className,
      )}
      {...props}
      style={wrap ? style : { ...SCROLL_SHADOWS_SUNKEN, ...style }}
    />
  );
}
const SCROLL_SHADOWS_SUNKEN: CSSProperties = {
  background: String(SCROLL_SHADOWS.background).replaceAll("var(--ph-bg)", "var(--ph-surface-sunken)"),
};

/** How a heading looks, by the level it was written at (1 to 6). */
const HEADING_LOOK: Record<number, string> = {
  1: "mt-6 mb-2 text-xl font-semibold tracking-tight",
  2: "mt-6 mb-2 text-lg font-semibold",
  3: "mt-5 mb-1.5 text-md font-semibold",
  // Each level steps down in size or colour, so h3 and h4 never look the same.
  4: "mt-4 mb-1 text-base font-semibold",
  5: "mt-4 mb-1 text-base font-semibold text-ink-secondary",
  6: "mt-4 mb-1 text-sm font-semibold text-ink-secondary",
};

/**
 * A markdown heading at `rank` (1 = the reply's top level, see
 * remarkHeadingLevels) as an element two levels down: the space is the page's
 * h1 and each message carries its own h2 ("Phaethon replied"), so a reply's
 * top level is an h3 and no level is skipped. It looks as it was written.
 */
function heading(rank: number) {
  const Tag = `h${Math.min(6, rank + 2)}` as "h3" | "h4" | "h5" | "h6";
  return function Heading({ className, ...props }: ComponentProps<"h3"> & { "data-md-depth"?: number | string }) {
    const written = Number(props["data-md-depth"] ?? rank);
    return <Tag className={cn(HEADING_LOOK[written] ?? HEADING_LOOK[6], "first:mt-0 last:mb-0", className)} {...props} />;
  };
}

/**
 * A task-list box ("- [x] Read chapter 7"): a plain box at full strength, with
 * a tick when done, read as "Done:" or "To do:". Not a disabled checkbox, which
 * looks greyed out, like a control you may not use yet.
 */
function TaskBox({ checked }: { checked: boolean }) {
  return (
    <span
      data-task={checked ? "done" : "todo"}
      className="absolute start-0 top-[calc((1lh-var(--ph-icon-size))/2)] inline-flex size-(--ph-icon-size) items-center justify-center rounded-xs border-2 border-ink-secondary text-ink"
    >
      {checked && <Icon name="check" className="size-(--ph-icon-size-sm)" />}
      <span className="sr-only">{checked ? "Done: " : "To do: "}</span>
    </span>
  );
}

/**
 * A link. One to a file in the space (a relative path, or courses/...) opens
 * it in the viewer, through the core's walls; any other opens outside the app.
 */
function Anchor({ className, href, children, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const space = useContext(SpaceIdContext);
  const base = useLinkBase();
  const cite = citationOf(href);
  if (cite) return <CitationChip path={cite.path} quote={cite.quote} />;
  const path = space ? spacePathOf(href, base) : null;
  if (path) {
    return (
      <SpaceFileLink space={space} path={path} className={cn("inline", className)} title={path}>
        {children}
      </SpaceFileLink>
    );
  }
  return (
    <a className={cn("text-accent-ink underline decoration-1 hover:decoration-2", className)} target="_blank" rel="noreferrer" href={href} {...props}>
      {children}
    </a>
  );
}

/** The elements markdown becomes. */
const elements = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  p: ({ className, ...props }) => <p className={cn("my-3 first:mt-0 last:mb-0", className)} {...props} />,
  a: Anchor,
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-3 border-s-2 border-line-strong ps-4 text-ink-secondary", className)} {...props} />
  ),
  // A task list ("- [ ] …") has no bullets: the box marks each item.
  ul: ({ className, ...props }) =>
    className?.includes("contains-task-list") ? (
      <ul className={cn("my-3 flex list-none flex-col gap-1", className)} {...props} />
    ) : (
      <ul className={cn("my-3 ms-5 list-disc marker:text-ink-tertiary [&>li]:mt-1", className)} {...props} />
    ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-3 ms-5 list-decimal marker:text-ink-secondary [&>li]:mt-1", className)} {...props} />
  ),
  li: ({ className, ...props }) =>
    className?.includes("task-list-item") ? (
      // The box hangs in the indent, so wrapped lines (and nested items) start under the text.
      <li className={cn("relative ps-[calc(var(--ph-icon-size)+var(--ph-space)*2)]", className)} {...props} />
    ) : (
      <li className={cn("ps-1", className)} {...props} />
    ),
  input: ({ type, checked, ...props }) =>
    type === "checkbox" ? <TaskBox checked={!!checked} /> : <input type={type} checked={checked} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-5 border-line", className)} {...props} />,
  table: Table,
  thead: ({ className, ...props }) => <thead className={cn("bg-surface", className)} {...props} />,
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border-b border-line px-3 py-2 text-start font-semibold [[align=center]]:text-center [[align=right]]:text-end",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "border-b border-line px-3 py-2 align-top text-start [[align=center]]:text-center [[align=right]]:text-end",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => <tr className={cn("last:[&>td]:border-b-0", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("font-semibold", className)} {...props} />,
  sup: ({ className, ...props }) => <sup className={cn("[&>a]:text-xs [&>a]:no-underline", className)} {...props} />,
} satisfies Components;

/** A fence drawn as more than code: a diagram, a LaTeX document, a figure. Null for any other. */
function richFence(language: string, code: string): ReactNode {
  switch (language.toLowerCase()) {
    case "mermaid":
      return <MermaidDiagram code={code} />;
    case "latex":
    case "tex":
      return isLatexDocument(code) ? <LatexDocumentCard source={code} /> : null;
    case "tikz":
      return <TikzFigure source={code} />;
    default:
      return null;
  }
}

/** In a message: a rich fence once it is closed; until then (and for a LaTeX snippet) the code as usual. */
function RichHighlighter(props: SyntaxHighlighterProps) {
  const closed = useFenceClosed(props.node as Positioned | undefined);
  const rich = closed ? richFence(props.language, props.code.replace(/\n$/, "")) : null;
  return rich ?? <SyntaxHighlighter {...props} />;
}
/** The code bar goes with the code: not over a diagram, a document card or a figure. */
function RichCodeHeader(props: CodeHeaderProps) {
  const closed = useFenceClosed(props.node as Positioned | undefined);
  const lang = (props.language ?? "").toLowerCase();
  const drawn = closed && (lang === "mermaid" || lang === "tikz" || ((lang === "latex" || lang === "tex") && isLatexDocument(props.code)));
  return drawn ? null : <CodeHeader {...props} />;
}
const RICH = { SyntaxHighlighter: RichHighlighter, CodeHeader: RichCodeHeader };
const RICH_FENCES: NonNullable<MarkdownTextPrimitiveProps["componentsByLanguage"]> = { mermaid: RICH, latex: RICH, tex: RICH, tikz: RICH };

const defaultComponents = memoizeMarkdownComponents({
  ...elements,
  pre: Pre,
  code: Code,
  CodeHeader,
  SyntaxHighlighter,
});

type HastText = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastText[] };
const hastText = (n: HastText | undefined): string => (n?.type === "text" ? (n.value ?? "") : (n?.children ?? []).map(hastText).join(""));

/** For RichMarkdown: a code block has no header there, so it gets the full rounded box; a rich fence is drawn. */
const staticComponents: Components = {
  ...elements,
  pre: ({ className, node, ...props }) => {
    const code = (node as HastText | undefined)?.children?.find((c) => c.type === "element" && c.tagName === "code");
    const cls = code?.properties?.className;
    const lang = (Array.isArray(cls) ? cls : []).map(String).find((c) => c.startsWith("language-"))?.slice(9);
    const rich = lang ? richFence(lang, hastText(code).replace(/\n$/, "")) : null;
    if (rich) return rich;
    return (
      <pre
        tabIndex={0}
        className={cn(
          "my-3 overflow-x-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-sm leading-normal",
          className,
        )}
        {...props}
      />
    );
  },
  code: ({ className, ...props }) => (
    <code
      className={cn(
        "rounded-xs border border-line bg-surface px-1 py-px font-mono text-sm [pre_&]:border-0 [pre_&]:bg-transparent [pre_&]:p-0",
        className,
      )}
      {...props}
    />
  ),
};
