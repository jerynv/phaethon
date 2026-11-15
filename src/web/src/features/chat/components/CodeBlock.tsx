import { CheckIcon, CopyIcon, FileCodeIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "@/components/file-chip";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

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
export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      onClick={copy}
      className={cn("inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", className)}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? "done" : "copy"}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ type: "spring", duration: 0.25, bounce: 0.35 }}
          className="inline-flex"
        >
          {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
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
        <div className="flex h-7 items-center justify-between border-b px-3">
          <span className="font-mono text-2xs text-muted-foreground">{lang ?? "text"}</span>
          <CopyButton text={code} className="-mr-1.5 size-5" label="Copy code" />
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
          <CopyIcon />
          Copy code
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyText(fenced, "Copied as Markdown")}>
          <FileCodeIcon />
          Copy as Markdown
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}
