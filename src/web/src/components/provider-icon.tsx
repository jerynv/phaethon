import { ServerIcon } from "lucide-react";
import anthropic from "@/assets/providers/anthropic.svg";
import claude from "@/assets/providers/claude.svg";
import deepseek from "@/assets/providers/deepseek.svg";
import gemini from "@/assets/providers/gemini.svg";
import groq from "@/assets/providers/groq.svg";
import lmstudio from "@/assets/providers/lmstudio.svg";
import mistral from "@/assets/providers/mistral.svg";
import ollama from "@/assets/providers/ollama.svg";
import openai from "@/assets/providers/openai.svg";
import openrouterDark from "@/assets/providers/openrouter-dark.svg";
import openrouterLight from "@/assets/providers/openrouter-light.svg";
import together from "@/assets/providers/together.svg";
import xai from "@/assets/providers/xai.svg";
import { cn } from "@/lib/utils";

/**
 * A provider's or coding agent's mark. Monochrome marks are drawn black and
 * inverted in dark mode; OpenRouter has its own light and dark artwork.
 * Anything unknown (a self-hosted server) gets a plain server glyph.
 */
const MARKS: Record<string, { src: string; mono?: boolean; dark?: string }> = {
  anthropic: { src: anthropic, mono: true },
  "claude-cli": { src: claude },
  claude: { src: claude },
  openai: { src: openai, mono: true },
  "codex-cli": { src: openai, mono: true },
  codex: { src: openai, mono: true },
  "gemini-cli": { src: gemini },
  gemini: { src: gemini },
  openrouter: { src: openrouterLight, dark: openrouterDark },
  groq: { src: groq },
  together: { src: together },
  mistral: { src: mistral },
  deepseek: { src: deepseek },
  xai: { src: xai, mono: true },
  ollama: { src: ollama, mono: true },
  lmstudio: { src: lmstudio },
};

export function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const mark = MARKS[id];
  if (!mark) return <ServerIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} strokeWidth={1.75} />;
  if (mark.dark) {
    return (
      <>
        <img alt="" aria-hidden src={mark.src} className={cn("size-4 shrink-0 dark:hidden", className)} draggable={false} />
        <img alt="" aria-hidden src={mark.dark} className={cn("hidden size-4 shrink-0 dark:block", className)} draggable={false} />
      </>
    );
  }
  return <img alt="" aria-hidden src={mark.src} className={cn("size-4 shrink-0", mark.mono && "dark:invert", className)} draggable={false} />;
}
