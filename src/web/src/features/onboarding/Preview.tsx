import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { HUES } from "@/app/NewSpaceDialog";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { SpaceAvatar } from "@/components/space-avatar";
import { cn } from "@/lib/utils";
import type { Draft } from "./Onboarding";

/**
 * What each onboarding step sets up, drawn small inside the art panel
 * (docs/UI-REBUILD.md › Onboarding; the inbox in e3e4's right half, the phone
 * in 3940's). It follows the draft as the person types: the provider they
 * picked, the space they're naming, whether study tools are on. Decorative:
 * the panel is aria-hidden and nothing here is focusable.
 */
export function StepPreview({ step, draft }: { step: number; draft: Draft }) {
  if (step === 1) return <AnswersPreview draft={draft} />;
  if (step === 2) return <SpacePreview draft={draft} />;
  return <AppPreview spaces={step === 3 && draft.spaces.length ? draft.spaces : ["School", "Work", "Personal"]} />;
}

/** A window that sits in the panel and runs off its bottom-right edge. */
function Window({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 12, y: 12 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 40, delay: 0.08 }}
      className="pointer-events-none absolute top-20 left-16 -right-px -bottom-px flex select-none overflow-hidden rounded-tl-panel border-t border-l bg-background"
    >
      {children}
    </motion.div>
  );
}

function SideRow({ children, selected, className }: { children: ReactNode; selected?: boolean; className?: string }) {
  return <div className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-sm", selected && "bg-row-selected", className)}>{children}</div>;
}

function Sidebar({ spaces, active, recents }: { spaces: { name: string; hue: number }[]; active?: number; recents?: string[] }) {
  return (
    <div className="flex w-52 shrink-0 flex-col border-r">
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <BrandMark className="size-4" />
        <span className="font-medium text-sm">Phaethon</span>
      </div>
      <div className="flex flex-col gap-px p-2">
        <span className="flex h-7 items-center px-2 text-subtle-foreground text-xs">Spaces</span>
        {spaces.map((s, i) => (
          <div key={`${s.name}-${i}`}>
            <SideRow selected={i === active}>
              <SpaceAvatar name={s.name} hue={s.hue} />
              <span className="truncate">{s.name}</span>
            </SideRow>
            {i === 0 && recents
              ? recents.map((r) => (
                  <SideRow key={r} className="pl-8 text-muted-foreground">
                    <span className="truncate">{r}</span>
                  </SideRow>
                ))
              : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const TABS = [
  { label: "Chat", icon: icons.chat },
  { label: "Study", icon: icons.study },
  { label: "Grades", icon: icons.grades },
  { label: "Plan", icon: icons.plan },
  { label: "Courses", icon: icons.courses },
];

function TitleBar({ study }: { study: boolean }) {
  const tabs = study ? TABS : TABS.slice(0, 1);
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b px-3">
      <AnimatePresence initial={false}>
        {tabs.map((t, i) => (
          <motion.span
            key={t.label}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.18, delay: i * 0.04 }}
            className={cn("flex h-7 items-center gap-1.5 rounded-lg px-2.5 font-medium text-sm", i === 0 ? "bg-row-selected text-foreground" : "text-muted-foreground")}
          >
            <Icon icon={t.icon} className="size-4" />
            {t.label}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Welcome() {
  return (
    <div className="flex flex-1 flex-col items-center px-8 pt-16">
      <BrandMark className="size-6" />
      <p className="mt-4 text-xl tracking-title">Where should we begin?</p>
      <div className="mt-6 w-full max-w-md rounded-card border bg-card p-3">
        <p className="h-12 text-placeholder text-sm">Ask anything…</p>
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-control border">
            <Icon icon={icons.attach} className="size-3.5 text-muted-foreground" />
          </span>
          <span className="flex-1" />
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/30 text-primary-foreground">
            <Icon icon={icons.send} className="size-3.5" />
          </span>
        </div>
      </div>
      <div className="mt-2 flex w-full max-w-md flex-wrap justify-center gap-1.5">
        {[
          { icon: icons.teacher, title: "Teach me" },
          { icon: icons.quiz, title: "Quiz me" },
          { icon: icons.plan, title: "Plan my week" },
        ].map((c) => (
          <span key={c.title} className="flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-xs">
            <Icon icon={c.icon} className="size-3 text-muted-foreground" />
            {c.title}
          </span>
        ))}
      </div>
    </div>
  );
}

function AppPreview({ spaces }: { spaces: string[] }) {
  const list = spaces.map((name, i) => ({ name, hue: HUES[i % HUES.length]! }));
  return (
    <Window>
      <Sidebar spaces={list} active={0} recents={["Plan for the week", "Notes from Tuesday"]} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar study />
        <Welcome />
      </div>
    </Window>
  );
}

function SpacePreview({ draft }: { draft: Draft }) {
  const name = draft.name.trim() || "New space";
  return (
    <Window>
      <Sidebar
        spaces={[
          { name, hue: HUES[0]! },
          { name: "Work", hue: HUES[2]! },
        ]}
        active={0}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar study={draft.edu} />
        <div className="flex flex-1 flex-col gap-3 p-8">
          <SpaceAvatar name={name} hue={HUES[0]!} className="size-10 rounded-xl text-base" />
          <p className="truncate text-xl tracking-title">{name}</p>
          <p className="text-muted-foreground text-sm">{draft.edu ? "Chat, study, grades, a plan and courses" : "Chat, files and memory"}</p>
        </div>
      </div>
    </Window>
  );
}

const KEY_ROWS = ["anthropic", "openai", "openrouter", "mistral", "groq"] as const;
const AGENT_ROWS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
] as const;
const NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", mistral: "Mistral", groq: "Groq" };

/** 9e25's list: a card of brand rows, the chosen one switched on. */
function AnswersPreview({ draft }: { draft: Draft }) {
  const agent = draft.method === "agent";
  const rows = agent ? AGENT_ROWS.map((r) => ({ id: r.id, name: r.name })) : KEY_ROWS.map((id) => ({ id, name: NAMES[id]! }));
  const chosen = agent ? AGENT_ROWS.find((r) => r.name === draft.answer)?.id : draft.provider;
  return (
    <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center p-12">
      <motion.div
        key={agent ? "agent" : "key"}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 40 }}
        className="w-full max-w-sm rounded-panel border bg-card p-6"
      >
        <p className="mb-3 text-lg tracking-title">{agent ? "Coding agents" : "Providers"}</p>
        <div className="flex flex-col">
          {rows.map((r) => {
            const on = r.id === chosen;
            return (
              <div key={r.id} className="flex h-11 items-center gap-3">
                <ProviderIcon id={r.id} />
                <span className="flex-1 text-sm">{r.name}</span>
                {on && draft.answer ? <span className="text-success-foreground text-xs">Ready</span> : null}
                <span className={cn("flex h-5 w-8 items-center rounded-full p-0.5 transition-colors duration-200", on ? "justify-end bg-primary" : "bg-input")}>
                  <motion.span layout transition={{ type: "spring", stiffness: 520, damping: 36 }} className="size-4 rounded-full bg-white" />
                </span>
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
