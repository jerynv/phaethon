import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
  return {
    copied,
    copy: () =>
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }),
  };
}

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      onClick={copy}
      className={cn("inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", className)}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" strokeWidth={2.25} /> : <CopyIcon className="size-3.5" strokeWidth={1.75} />}
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
  return (
    <div className="md-code group/code">
      <div className="flex h-7 items-center justify-between border-b px-3">
        <span className="font-mono text-2xs text-muted-foreground">{lang ?? "text"}</span>
        <CopyButton text={code} className="-mr-1.5 size-5" label="Copy code" />
      </div>
      {html ? <div className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="md-code-body"><code>{code}</code></pre>}
    </div>
  );
}
