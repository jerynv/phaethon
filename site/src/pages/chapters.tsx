import anthropic from "@/assets/providers/anthropic.svg";
import claude from "@/assets/providers/claude.svg";
import lmstudio from "@/assets/providers/lmstudio.svg";
import mistral from "@/assets/providers/mistral.svg";
import ollama from "@/assets/providers/ollama.svg";
import openai from "@/assets/providers/openai.svg";
import openrouterDark from "@/assets/providers/openrouter-dark.svg";
import openrouterLight from "@/assets/providers/openrouter-light.svg";
import { type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { cn } from "@/lib/utils";
import { DemoFrame } from "../demos/frame.tsx";
import { meta } from "../demos/meta.ts";
import { Container } from "../layout.tsx";

// The demos load on their own, once one is near the screen: the page reserves
// their boxes and describes them (demos/meta.ts) without waiting for them.
const demos: Record<keyof typeof meta, ComponentType> = {
  spaces: lazy(() => import("../demos/spaces.tsx")),
  approve: lazy(() => import("../demos/approve.tsx")),
  models: lazy(() => import("../demos/models.tsx")),
  vault: lazy(() => import("../demos/vault.tsx")),
};

function Demo({ id }: { id: keyof typeof meta }) {
  const Shown = demos[id];
  return (
    <DemoFrame size={meta[id].size} label={meta[id].label}>
      {() => (
        <Suspense fallback={<div aria-hidden data-loading="" className="ph-frame__ground" />}>
          <div className="ph-frame__stage">
            <Shown />
          </div>
        </Suspense>
      )}
    </DemoFrame>
  );
}

/** The providers and agents Phaethon talks to, by their own marks (src/web/src/components/provider-icon.tsx). */
const PROVIDERS: { name: string; src: string; dark?: string; mono?: boolean }[] = [
  { name: "Anthropic", src: anthropic, mono: true },
  { name: "OpenAI", src: openai, mono: true },
  { name: "OpenRouter", src: openrouterLight, dark: openrouterDark },
  { name: "Mistral", src: mistral },
  { name: "Ollama", src: ollama, mono: true },
  { name: "LM Studio", src: lmstudio },
  { name: "Claude Code", src: claude },
  { name: "Codex", src: openai, mono: true },
];

export function WorksWith() {
  return (
    <section aria-labelledby="works-title" className="pb-20 sm:pb-28">
      <Container className="flex flex-col items-center gap-6 text-center">
        <h2 id="works-title" data-reveal="" className="text-muted-foreground text-sm">
          Works with the AI you already use
        </h2>
        <ul className="flex max-w-5xl flex-wrap items-center justify-center gap-x-8 gap-y-4">
          {PROVIDERS.map((p, i) => (
            <li key={p.name} data-reveal="" style={{ ["--i" as string]: i }} className="flex items-center gap-2 font-medium text-[0.9375rem] text-foreground/80">
              {p.dark ? (
                <>
                  <img alt="" src={p.src} width={20} height={20} className="size-5 dark:hidden" />
                  <img alt="" src={p.dark} width={20} height={20} className="hidden size-5 dark:block" />
                </>
              ) : (
                <img alt="" src={p.src} width={20} height={20} className={cn("size-5", p.mono && "dark:invert")} />
              )}
              {p.name}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

type Chapter = { id: string; kicker: string; lead: string; rest: string; body: ReactNode; demo: keyof typeof meta };

/**
 * One idea each: a short name, the promise in two tones, then one plain
 * paragraph that says what the word means before it's used again, beside the
 * app doing it.
 */
const CHAPTERS: Chapter[] = [
  {
    id: "spaces",
    kicker: "Spaces",
    lead: "A separate space for each part of your life.",
    rest: " School, work and home stay apart.",
    body: (
      <>
        A <b>space</b> is its own room in the app, with its own files, chats and memory. The AI working in your School space can only see School. When it needs something from Work, it stops and asks, and you choose whether it may look.
      </>
    ),
    demo: "spaces",
  },
  {
    id: "agent",
    kicker: "Agent",
    lead: "It does the work.",
    rest: " And checks with you before it changes anything.",
    body: (
      <>
        An <b>agent</b> is an AI that can take steps for you, not just answer: read your notes, draft a plan, update a file. Before Phaethon’s agent changes a file, it shows you exactly what will change, and nothing is saved until you say yes.
      </>
    ),
    demo: "approve",
  },
  {
    id: "models",
    kicker: "Bring your own AI",
    lead: "Use the AI you already have.",
    rest: " Or one that never leaves your computer.",
    body: (
      <>
        A <b>model</b> is the AI that writes the replies. Add your own key from Anthropic or OpenAI, use Claude Code or Codex if you have them, or run a <b>local model</b> with Ollama, a free app that runs AI on your own machine, so what you type isn’t sent anywhere. Each space can use a different one.
      </>
    ),
    demo: "models",
  },
  {
    id: "vault",
    kicker: "Vault",
    lead: "Everything lives in a folder you own.",
    rest: " Plain files you can open without Phaethon.",
    body: (
      <>
        Your <b>vault</b> is one folder on your computer that holds it all: your spaces, your chats, and what Phaethon remembers about you, as ordinary text files. Back it up like any folder, or keep it the same on every computer with iCloud Drive, git or Syncthing.
      </>
    ),
    demo: "vault",
  },
];

export function Chapters() {
  return (
    <div className="flex flex-col gap-24 pb-24 sm:gap-32 sm:pb-32">
      {CHAPTERS.map((c, i) => (
        <section key={c.id} aria-labelledby={`${c.id}-title`}>
          <Container className={cn("grid items-center gap-x-14 gap-y-10", i % 2 === 1 ? "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]")}>
            <div className={cn("max-w-xl", i % 2 === 1 && "lg:order-last")}>
              <p data-reveal="" className="font-medium text-info-foreground text-sm">
                {c.kicker}
              </p>
              <h2 id={`${c.id}-title`} data-reveal="" style={{ ["--i" as string]: 1 }} className="mt-3 text-balance font-medium text-[clamp(1.75rem,1.3rem+1.2vw,2.25rem)] text-foreground leading-[1.1] tracking-[-0.03em]">
                {c.lead}
                <span className="text-muted-foreground">{c.rest}</span>
              </h2>
              <p data-reveal="" style={{ ["--i" as string]: 2 }} className="mt-5 text-pretty text-[1.0625rem] text-muted-foreground leading-relaxed [&_b]:font-medium [&_b]:text-foreground">
                {c.body}
              </p>
            </div>
            <div data-reveal="" style={{ ["--i" as string]: 1 }}>
              <Demo id={c.demo} />
            </div>
          </Container>
        </section>
      ))}
    </div>
  );
}
