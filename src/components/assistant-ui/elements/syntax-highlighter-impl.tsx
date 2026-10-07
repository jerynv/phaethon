/// <reference types="react-syntax-highlighter" />
// The highlighter itself, loaded only when a reply first shows a code block
// (see syntax-highlighter.tsx). Prism via react-syntax-highlighter (MIT), as in
// the assistant-ui registry's syntax-highlighter, with the languages people
// paste most registered up front (one lazy chunk, no network, no eval).
// Colours come from syntax.css (oklch, both themes), not inline styles.
import "./syntax.css";

import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import { useCodeWrap } from "@/hooks/use-code-wrap";

const LANGUAGES: Record<string, unknown> = {
  bash, c, cpp, csharp, css, diff, go, java, javascript, json, jsx, kotlin, markdown, markup,
  python, ruby, rust, sql, swift, toml, tsx, typescript, yaml,
};
for (const [name, grammar] of Object.entries(LANGUAGES)) SyntaxHighlighter.registerLanguage(name, grammar);

/** What people write after ``` mapped onto a registered grammar. */
const ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", py: "python", rs: "rust", rb: "ruby", html: "markup", xml: "markup",
  svg: "markup", md: "markdown", yml: "yaml", "c++": "cpp", cs: "csharp", kt: "kotlin", golang: "go", patch: "diff",
};

function knownLanguage(language: string): string | null {
  const l = language.toLowerCase();
  const name = ALIASES[l] ?? l;
  return name in LANGUAGES ? name : null;
}

export default function Highlighted({ language, code, components }: SyntaxHighlighterProps) {
  const name = knownLanguage(language);
  // Prism sets white-space on the code element itself, so it is told too.
  const wrap = useCodeWrap();
  const { Pre, Code } = components;
  if (!name) {
    return (
      <Pre>
        <Code>{code}</Code>
      </Pre>
    );
  }
  return (
    <SyntaxHighlighter language={name} useInlineStyles={false}
      wrapLongLines={wrap}
      // A fresh object each time: the library's default one is shared and keeps the first white-space it saw.
      codeTagProps={{ style: { whiteSpace: wrap ? "pre-wrap" : "pre" } }}
      PreTag={Pre} CodeTag={Code}>
      {code}
    </SyntaxHighlighter>
  );
}
