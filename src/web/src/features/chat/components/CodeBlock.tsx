import { useEffect, useRef, useState } from "react";
import { copyText } from "@/components/file-chip";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";

/**
 * Shiki, loaded lazily with the JS regex engine, only the two themes used here,
 * and a curated set of common languages so Vite doesn't ship 200+ grammars and
 * 60+ themes (which added ~9 MB to dist/web).
 */
type LangLoader = () => Promise<{ default: unknown }>;
const LANG_LOADERS: Record<string, LangLoader> = {
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  csharp: () => import("shiki/dist/langs/csharp.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  scss: () => import("shiki/dist/langs/scss.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  powershell: () => import("shiki/dist/langs/powershell.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  latex: () => import("shiki/dist/langs/latex.mjs"),
  tex: () => import("shiki/dist/langs/tex.mjs"),
  r: () => import("shiki/dist/langs/r.mjs"),
  julia: () => import("shiki/dist/langs/julia.mjs"),
  matlab: () => import("shiki/dist/langs/matlab.mjs"),
  haskell: () => import("shiki/dist/langs/haskell.mjs"),
  ocaml: () => import("shiki/dist/langs/ocaml.mjs"),
  scheme: () => import("shiki/dist/langs/scheme.mjs"),
  prolog: () => import("shiki/dist/langs/prolog.mjs"),
  scala: () => import("shiki/dist/langs/scala.mjs"),
  lua: () => import("shiki/dist/langs/lua.mjs"),
  dart: () => import("shiki/dist/langs/dart.mjs"),
  zig: () => import("shiki/dist/langs/zig.mjs"),
  docker: () => import("shiki/dist/langs/docker.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  http: () => import("shiki/dist/langs/http.mjs"),
  csv: () => import("shiki/dist/langs/csv.mjs"),
  ini: () => import("shiki/dist/langs/ini.mjs"),
  make: () => import("shiki/dist/langs/make.mjs"),
  mermaid: () => import("shiki/dist/langs/mermaid.mjs"),
  regexp: () => import("shiki/dist/langs/regexp.mjs"),
};
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  "c#": "csharp",
  rs: "rust",
  rb: "ruby",
  kt: "kotlin",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  ps1: "powershell",
  md: "markdown",
  hs: "haskell",
  ml: "ocaml",
  scm: "scheme",
  pl: "prolog",
  dockerfile: "docker",
  makefile: "make",
  gql: "graphql",
  regex: "regexp",
};

type Highlighter = Awaited<ReturnType<typeof import("shiki/core")["createHighlighterCore"]>>;
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();
const loadingLangs = new Map<string, Promise<void>>();
const cache = new Map<string, string>();

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/dist/themes/github-light.mjs"),
    import("shiki/dist/themes/github-dark-default.mjs"),
  ]).then(([core, engine, light, dark]) =>
    core.createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
    }),
  );
  return highlighterPromise;
}

async function ensureLang(h: Highlighter, lang: string): Promise<string> {
  const lower = lang.toLowerCase();
  const canonical = LANG_ALIASES[lower] ?? lower;
  const loader = LANG_LOADERS[canonical];
  if (!loader) return "text";
  if (!loadedLangs.has(canonical)) {
    let p = loadingLangs.get(canonical);
    if (!p) {
      p = loader()
        .then((mod) => h.loadLanguage(mod.default as never))
        .then(() => {
          loadedLangs.add(canonical);
        })
        .finally(() => loadingLangs.delete(canonical));
      loadingLangs.set(canonical, p);
    }
    await p;
  }
  return canonical;
}

async function highlight(code: string, lang: string): Promise<string> {
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = await getHighlighter();
  const known = await ensureLang(h, lang);
  const html = h.codeToHtml(code, { lang: known, themes: { light: "github-light", dark: "github-dark-default" }, defaultColor: false });
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
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1400);
        })
        .catch(() => {}),
  };
}

export { CopyButton };

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
          <span className="text-muted-foreground text-xs">{langName(lang)}</span>
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
