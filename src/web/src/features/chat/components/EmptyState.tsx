import { BookOpenIcon, CalendarCheckIcon, CircleHelpIcon, FilesIcon, ListChecksIcon, NotebookPenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";

import { hueColor } from "../context";

const EDUCATION: { icon: LucideIcon; label: string; prompt: string }[] = [
  { icon: CalendarCheckIcon, label: "What’s due this week", prompt: "What’s coming up this week in my courses, and what should I do first?" },
  { icon: BookOpenIcon, label: "Teach me a topic", prompt: "Teach me a topic from my course step by step, checking that I follow: " },
  { icon: ListChecksIcon, label: "Quiz me", prompt: "Quiz me on what we covered most recently, one question at a time." },
  { icon: NotebookPenIcon, label: "Plan for an exam", prompt: "Help me make a study plan for my next exam." },
];

const GENERAL: { icon: LucideIcon; label: string; prompt: string }[] = [
  { icon: FilesIcon, label: "What’s in this space", prompt: "Look through the files in this space and tell me what’s here." },
  { icon: PenLineIcon, label: "Help me write", prompt: "Help me write " },
  { icon: CircleHelpIcon, label: "Explain something", prompt: "Explain this to me step by step: " },
  { icon: SparklesIcon, label: "Plan my week", prompt: "Help me plan my week. Here’s what I have on: " },
];

/**
 * An empty conversation: what this space is for, in one line, and a few
 * ways to start. A starter fills the message box; nothing is sent.
 */
export function EmptyState({
  spaceName,
  hue,
  description,
  education,
  onStart,
}: {
  spaceName: string;
  hue?: number;
  description?: string;
  education: boolean;
  onStart: (prompt: string) => void;
}) {
  const starters = education ? EDUCATION : GENERAL;
  return (
    <div className="flex flex-1 flex-col justify-center-safe gap-6 py-10" data-empty-state="">
      <div className="flex flex-col items-center gap-2 text-center">
        <span aria-hidden className="mb-1 size-2.5 rounded-full" style={{ background: hueColor(hue) }} />
        <h2 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">What are we working on in {spaceName}?</h2>
        {description && <p className="max-w-md text-[0.9375rem] text-muted-foreground text-balance">{description}</p>}
      </div>
      <ul aria-label="Ways to start" className="mx-auto grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {starters.map((s) => (
          <li key={s.label}>
            <button
              type="button"
              onClick={() => onStart(s.prompt)}
              className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl border bg-card px-3.5 py-2.5 text-start text-[0.9375rem] transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <s.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span>{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
