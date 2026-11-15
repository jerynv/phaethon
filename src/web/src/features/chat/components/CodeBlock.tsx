import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "@/components/file-chip";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";

/** Shiki, loaded the first time a code block appears; dual themes switch with `.dark`. */
let shiki: Promise<typeof import("shiki")> | null = null;
const cache = new Map<string, string>();

async function highlight(code: string, lang: string): Promise<string> {
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  shiki ??= import("shiki");
  const { codeToHtml, bundledLanguages } = await shiki;
  const known = lang in bundledLanguages ? lang : "text";
  const html = await codeToHtml(code, { lang: known, themes: { light: "github-light", dark: "github-dark-default" }, defaultColor: false });
  if (cache.size > 200) cache.clear();
  cache.set(key, html);
  return html;
}

export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    copied,
    copy: () =>
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      }),
  };
}

/** Copy with a confirmation that swaps the glyph for a check, briefly. */
export function CopyButton({ text, className, label = "Copy", variant = "ghost-muted" }: { text: string; className?: string; label?: string; variant?: "ghost-muted" | "outline" }) {
  const { copied, copy } = useCopy(text);
  return (
    <Button type="button" variant={variant} size="icon-xs" aria-label={copied ? "Copied" : label} onClick={copy} className={className}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? "done" : "copy"}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ type: "spring", duration: 0.25, bounce: 0.35 }}
          className="inline-flex"
        >
          {copied ? <Icon icon={icons.check} className="size-3.5 text-success" /> : <Icon icon={icons.copy} className="size-3.5" />}
        </motion.span>
      </AnimatePresence>
    </Button>
  );
}

/** "python" → "Python", "json" → "JSON": the block's label reads like a word, after ref 7cad's "JSON". */
const LANG_NAMES: Record<string, string> = { json: "JSON", js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", html: "HTML", css: "CSS", sql: "SQL", sh: "Shell", bash: "Bash", zsh: "Shell", yaml: "YAML", yml: "YAML", md: "Markdown", markdown: "Markdown", py: "Python", cpp: "C++", csharp: "C#", cs: "C#", tex: "LaTeX", latex: "LaTeX", text: "Text" };
function langName(lang?: string): string {
  const l = (lang ?? "text").toLowerCase();
  return LANG_NAMES[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void highlight(code, lang ?? "text").then((h) => live && setHtml(h), () => {});
    }, 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, lang]);
  const fenced = "```" + (lang ?? "") + "\n" + code + "\n```";
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="md-code group/code" data-slot="code-block" />}>
        <div className="flex h-9 items-center justify-between pr-1.5 pl-3.5">
          <span className="text-muted-foreground text-sm">{langName(lang)}</span>
          <CopyButton text={code} label="Copy code" />
        </div>
        {html ? (
          <div className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="md-code-body">
            <code>{code}</code>
          </pre>
        )}
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onClick={() => void copyText(code, "Code copied")}>
          <Icon icon={icons.copy} />
          Copy code
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyText(fenced, "Copied as Markdown")}>
          <Icon icon={icons.fileCode} />
          Copy as Markdown
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}
