import { ArrowLeftIcon, ArrowRightIcon, LibraryBigIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { SpaceMark } from "@/app/SpaceMark";
import { Button } from "@/components/ui/button";
import { AssistantSettings } from "@/features/settings/AssistantSettings";
import { cn } from "@/lib/utils";

const DONE_KEY = "phaethon.onboarded";

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Without storage, setup shows again next launch; nothing breaks.
  }
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const countWord = (n: number) => WORDS[n] ?? String(n);

type Step = "welcome" | "assistant" | "courses";
const STEPS: Step[] = ["welcome", "assistant", "courses"];

export type OnboardingResult = { openCourses: boolean; spaceId?: string };

/**
 * First run, three short steps: what Phaethon is, how it answers (the
 * assistant settings, embedded), and course sites (optional). Skippable at
 * any point; finishing or skipping is remembered.
 */
export function Onboarding({ onFinish }: { onFinish(result: OnboardingResult): void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<Step>(step);
  const index = STEPS.indexOf(step);

  useEffect(() => {
    api.spaces().then(setSpaces, () => {});
  }, []);

  // Each step's heading takes focus, so a screen reader starts at the top of it.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  const finish = (result: OnboardingResult) => {
    markOnboarded();
    onFinish(result);
  };
  const school = spaces.find((s) => s.educationEnabled) ?? spaces.find((s) => s.id === "school");

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="drag-region flex h-12 shrink-0 items-center justify-between ps-[calc(var(--titlebar-inset-start)+1rem)] pe-3">
        <span className="font-semibold text-sm tracking-wide">Phaethon</span>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => finish({ openCourses: false })}>
          Skip setup
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-labelledby="onboarding-heading">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 pt-[8vh] pb-10">
          <p className="mb-3 font-medium text-muted-foreground text-xs tracking-wide">
            Step {index + 1} of {STEPS.length}
          </p>
          <div aria-hidden="true" className="mb-8 flex gap-1.5">
            {STEPS.map((s, i) => (
              <span key={s} className={cn("h-1 w-10 rounded-full", i <= index ? "bg-primary" : "bg-input")} />
            ))}
          </div>

          {step === "welcome" ? (
            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1} className="font-semibold text-3xl tracking-tight outline-none">
                  Welcome to Phaethon
                </h1>
                <p className="reading max-w-prose text-lg text-muted-foreground">
                  A calm place to think, study and work with the AI you choose, on files you keep.
                </p>
              </div>
              {spaces.length > 0 ? (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                  <p className="text-sm">
                    Each space keeps its own files and conversations. You start with {countWord(spaces.length)}:
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {spaces.map((s) => (
                      <li key={s.id} className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-sm">
                        <SpaceMark name={s.name} hue={s.hue} className="size-5" />
                        {s.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div>
                <Button size="lg" onClick={() => setStep("assistant")} autoFocus>
                  Get started
                  <ArrowRightIcon />
                </Button>
              </div>
            </section>
          ) : null}

          {step === "assistant" ? (
            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1} className="font-semibold text-2xl tracking-tight outline-none">
                  Choose how Phaethon answers
                </h1>
              </div>
              <div className="min-h-24">
                <AssistantSettings />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
                <Button variant="ghost" onClick={() => setStep("welcome")}>
                  <ArrowLeftIcon />
                  Back
                </Button>
                <Button onClick={() => setStep("courses")}>
                  Continue
                  <ArrowRightIcon />
                </Button>
              </div>
            </section>
          ) : null}

          {step === "courses" ? (
            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1} className="font-semibold text-2xl tracking-tight outline-none">
                  Bring in your courses
                </h1>
                <p className="reading max-w-prose text-muted-foreground">
                  Phaethon can import course materials and grades from Canvas, Brightspace, Moodle or Blackboard, then make study decks and
                  practice quizzes grounded in them.
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-space-soft text-space-foreground">
                  <LibraryBigIcon aria-hidden="true" className="size-5" />
                </span>
                <p className="text-sm">
                  {school ? (
                    <>
                      Courses go in <span className="font-medium">{school.name}</span>, with Study, Grades and Plan beside the chat.
                    </>
                  ) : (
                    "Courses go in a space for school, with Study, Grades and Plan beside the chat."
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <Button variant="ghost" onClick={() => setStep("assistant")}>
                  <ArrowLeftIcon />
                  Back
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => finish({ openCourses: false })}>
                    Not now
                  </Button>
                  <Button onClick={() => finish({ openCourses: true, spaceId: school?.id })}>Set up courses</Button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
