import { ServerIcon } from "lucide-react";
import { useId } from "react";

import anthropic from "@/assets/providers/anthropic.svg?raw";
import claude from "@/assets/providers/claude.svg?raw";
import deepseek from "@/assets/providers/deepseek.svg?raw";
import gemini from "@/assets/providers/gemini.svg?raw";
import groq from "@/assets/providers/groq.svg?raw";
import lmstudio from "@/assets/providers/lmstudio.svg?raw";
import mistral from "@/assets/providers/mistral.svg?raw";
import ollama from "@/assets/providers/ollama.svg?raw";
import openai from "@/assets/providers/openai.svg?raw";
import openrouterDark from "@/assets/providers/openrouter-dark.svg?raw";
import openrouterLight from "@/assets/providers/openrouter-light.svg?raw";
import together from "@/assets/providers/together.svg?raw";
import xai from "@/assets/providers/xai.svg?raw";
import { cn } from "@/lib/utils";

import type { ProviderId } from "./api";

export type LogoId = ProviderId | "claude-cli" | "codex-cli" | "gemini-cli";

/** Vendored brand marks (Lobe Icons and T3 Code, MIT; see assets/providers/LICENSES.txt and sources.json). */
const MARKS: Record<Exclude<LogoId, "custom">, { svg: string; mono?: boolean; dark?: string }> = {
  anthropic: { svg: anthropic, mono: true },
  openai: { svg: openai, mono: true },
  openrouter: { svg: openrouterLight, dark: openrouterDark },
  groq: { svg: groq },
  together: { svg: together },
  mistral: { svg: mistral },
  deepseek: { svg: deepseek },
  xai: { svg: xai, mono: true },
  ollama: { svg: ollama, mono: true },
  lmstudio: { svg: lmstudio },
  "claude-cli": { svg: claude },
  "codex-cli": { svg: openai, mono: true },
  "gemini-cli": { svg: gemini },
};

/** Inline SVG text with its ids made unique to this instance, sized to its box, and monochrome marks in currentColor. */
function prepare(svg: string, prefix: string, mono: boolean): string {
  let out = svg.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`);
  if (mono) out = out.replace(/fill="(?:black|#000|#000000)"/g, 'fill="currentColor"');
  return out.replace("<svg", '<svg width="100%" height="100%" aria-hidden="true" focusable="false"');
}

/** A provider's mark beside its visible name (decorative). */
export function ProviderLogo({ id, className }: { id: LogoId; className?: string }) {
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const mark = id === "custom" ? null : MARKS[id];
  const box = cn("inline-flex size-5 shrink-0 items-center justify-center [&_svg]:block", className);
  if (!mark) {
    return (
      <span aria-hidden className={box}>
        <ServerIcon className="size-[85%] text-muted-foreground" strokeWidth={1.75} />
      </span>
    );
  }
  if (mark.dark) {
    return (
      <span aria-hidden className={box}>
        <span className="size-full dark:hidden" dangerouslySetInnerHTML={{ __html: prepare(mark.svg, `${prefix}l`, false) }} />
        <span className="hidden size-full dark:block" dangerouslySetInnerHTML={{ __html: prepare(mark.dark, `${prefix}d`, false) }} />
      </span>
    );
  }
  return <span aria-hidden className={box} dangerouslySetInnerHTML={{ __html: prepare(mark.svg, prefix, !!mark.mono) }} />;
}
