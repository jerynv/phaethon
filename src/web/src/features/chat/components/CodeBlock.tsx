import { useEffect, useState } from "react";

import { CopyButton } from "./CopyButton";

const LANGUAGE_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX",
  py: "Python", python: "Python", rs: "Rust", rust: "Rust", sh: "Shell", bash: "Shell", zsh: "Shell", shell: "Shell",
  json: "JSON", yaml: "YAML", yml: "YAML", html: "HTML", css: "CSS", sql: "SQL", java: "Java", c: "C", cpp: "C++",
  go: "Go", latex: "LaTeX", tex: "LaTeX", tikz: "TikZ", md: "Markdown", markdown: "Markdown", r: "R", text: "Text",
};

/** Highlights with shiki, loaded on first use; both themes, the page picks one. */
type Highlighter = (code: string, lang: string) => Promise<string>;
let highlighter: Promise<Highlighter> | null = null;
function loadHighlighter(): Promise<Highlighter> {
  highlighter ??= import("shiki").then(({ codeToHtml }) => async (code: string, lang: string) => {
    const opts = { themes: { light: "github-light-default", dark: "github-dark-default" }, defaultColor: false } as const;
    try {
      return await codeToHtml(code, { ...opts, lang });
    } catch {
      return await codeToHtml(code, { ...opts, lang: "text" });
    }
  });
  return highlighter;
}

const cache = new Map<string, string>();

/**
 * A fenced code block: its language and a Copy button above, the code in a
 * box that scrolls sideways and takes focus. Colours arrive once the reply
 * is done (highlighting every token while it streams would only flicker).
 */
export function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const key = `${lang}\n${code}`;
  const [html, setHtml] = useState<string | null>(() => cache.get(key) ?? null);
  useEffect(() => {
    if (streaming || cache.has(key) || code.length > 200_000) {
      setHtml(cache.get(key) ?? null);
      return;
    }
    let live = true;
    void loadHighlighter()
      .then((h) => h(code, lang || "text"))
      .then((out) => {
        cache.set(key, out);
        if (cache.size > 300) cache.delete(cache.keys().next().value!);
        if (live) setHtml(out);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, code, lang, streaming]);
  const name = LANGUAGE_NAMES[lang.toLowerCase()] ?? (lang ? lang : "Code");
  return (
    <div className="ph-block ph-code overflow-hidden rounded-lg border bg-muted/40" data-code-block={lang || "text"}>
      <div className="flex h-8 items-center justify-between gap-2 border-b bg-muted/50 ps-3 pe-1 text-xs text-muted-foreground">
        <span className="truncate font-medium">{name}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      {html ? (
        <div
          tabIndex={0}
          role="region"
          aria-label={`${name} code`}
          className="overflow-x-auto px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          tabIndex={0}
          aria-label={`${name} code`}
          className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
