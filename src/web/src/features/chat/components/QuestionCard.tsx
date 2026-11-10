import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { CheckIcon, CircleAlertIcon, LightbulbIcon, MessageSquareQuoteIcon, PlusIcon, SendHorizontalIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { LessonAnswer } from "#shared/agent.ts";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { PendingQuestion } from "../lib/timeline";
import { Confidence } from "./Confidence";
import { Markdown } from "./Markdown";
import { modKey } from "./keys";

const optionRow =
  "group flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-2.5 text-start transition-colors hover:bg-accent/50 has-[[data-checked]]:border-primary/60 has-[[data-checked]]:bg-primary/5 forced-colors:has-[[data-checked]]:border-[Highlight] forced-colors:has-[[data-checked]]:border-2 has-focus-visible:outline-2 has-focus-visible:outline-ring";

const indicatorBox =
  "mt-0.5 flex size-4.5 shrink-0 items-center justify-center border border-input bg-background outline-none data-checked:border-primary data-checked:bg-primary forced-colors:border-[CanvasText] forced-colors:data-checked:border-[Highlight] forced-colors:data-checked:bg-[Highlight]";

/**
 * A question from the lesson, in place of the composer until it's answered:
 * the options (one, or several), "I don't know", how sure the student is,
 * and their reasoning if they want to give it. An explain-back question
 * takes their own words instead of options.
 */
export function QuestionCard({ pending, onAnswer }: { pending: PendingQuestion; onAnswer: (answer: LessonAnswer) => Promise<string | null> }) {
  const q = pending.question;
  const isCheck = pending.kind === "check";
  const check = pending.kind === "check" ? pending.question : null;
  const ids = {
    title: useId(),
    conf: useId(),
    confLabel: useId(),
    reason: useId(),
    error: useId(),
    hint: useId(),
  };
  const [chosen, setChosen] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [problem, setProblem] = useState<{ text: string; field?: "choice" | "text" | "confidence" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  // Arrives with focus on its first control, so the answer can start at once.
  useEffect(() => {
    const first = form.current?.querySelector<HTMLElement>("[data-first-control]");
    first?.focus({ preventScroll: true });
    setChosen([]);
    setText("");
    setThinking("");
    setConfidence(null);
    setProblem(null);
    setBusy(false);
    setShowReason(false);
  }, [q.id]);

  const focusField = (field: "choice" | "text" | "confidence") => {
    const el =
      field === "confidence"
        ? form.current?.querySelector<HTMLElement>(`#${CSS.escape(ids.conf)}`)
        : form.current?.querySelector<HTMLElement>("[data-first-control]");
    el?.focus();
  };

  const send = async (answer: LessonAnswer) => {
    setBusy(true);
    const failed = await onAnswer(answer);
    if (failed) {
      setBusy(false);
      setProblem({ text: failed });
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (isCheck && chosen.length === 0) {
      setProblem({ text: check?.multiSelect ? "Choose at least one answer, or press I don’t know." : "Choose an answer, or press I don’t know.", field: "choice" });
      return focusField("choice");
    }
    if (!isCheck && text.trim() === "") {
      setProblem({ text: "Write your explanation, or press I don’t know.", field: "text" });
      return focusField("text");
    }
    if (confidence === null) {
      setProblem({ text: "Set how sure you are.", field: "confidence" });
      return focusField("confidence");
    }
    setProblem(null);
    void send({
      ...(isCheck ? { answers: chosen } : { text: text.trim() }),
      confidence,
      ...(thinking.trim() ? { thinking: thinking.trim() } : {}),
    });
  };

  const dontKnow = () => {
    if (busy) return;
    setProblem(null);
    void send({ dontKnow: true, ...(isCheck ? { answers: [] } : {}), ...(thinking.trim() ? { thinking: thinking.trim() } : {}) });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const Icon = isCheck ? (check?.role === "predict" ? LightbulbIcon : CheckIcon) : MessageSquareQuoteIcon;
  const kicker = isCheck ? (check?.role === "predict" ? "Before we start: your guess" : "Quick check") : "Explain it back";

  return (
    <form
      ref={form}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-labelledby={ids.title}
      className="flex max-h-[min(70dvh,40rem)] flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-[0_8px_30px_-12px_rgb(0_0_0/0.25)]"
      data-question-card={pending.kind}
    >
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{kicker}</p>
            <h2 id={ids.title} className="text-base leading-snug font-semibold">
              <Markdown inline text={q.question} headingShift={4} className="text-base font-semibold" />
            </h2>
          </div>
        </div>

        {check && !check.multiSelect && (
          <RadioGroupPrimitive
            value={chosen[0] ?? null}
            onValueChange={(v) => {
              setChosen(v === null || v === undefined ? [] : [String(v)]);
              if (problem?.field === "choice") setProblem(null);
            }}
            aria-labelledby={ids.title}
            aria-describedby={problem?.field === "choice" ? ids.error : undefined}
            aria-invalid={problem?.field === "choice" || undefined}
            className="flex flex-col gap-2"
          >
            {check.options.map((o, i) => (
              <label key={o.value} className={optionRow}>
                <RadioPrimitive.Root value={o.value} data-first-control={i === 0 ? "" : undefined} className={cn(indicatorBox, "rounded-full")}>
                  <RadioPrimitive.Indicator className="size-1.5 rounded-full bg-primary-foreground data-unchecked:hidden forced-colors:bg-[HighlightText]" />
                </RadioPrimitive.Root>
                <span className="min-w-0 flex-1 text-[0.9375rem] leading-normal">
                  <Markdown inline text={o.label} headingShift={4} className="text-[0.9375rem]" />
                </span>
              </label>
            ))}
          </RadioGroupPrimitive>
        )}

        {check?.multiSelect && (
          <div role="group" aria-labelledby={ids.title} aria-describedby={problem?.field === "choice" ? ids.error : ids.hint} className="flex flex-col gap-2">
            <p id={ids.hint} className="text-sm text-muted-foreground">
              Choose every answer that applies.
            </p>
            {check.options.map((o, i) => (
              <label key={o.value} className={optionRow}>
                <CheckboxPrimitive.Root
                  checked={chosen.includes(o.value)}
                  onCheckedChange={(on) => {
                    setChosen((c) => (on ? [...c, o.value] : c.filter((x) => x !== o.value)));
                    if (problem?.field === "choice") setProblem(null);
                  }}
                  data-first-control={i === 0 ? "" : undefined}
                  className={cn(indicatorBox, "rounded-[0.25rem]")}
                >
                  <CheckboxPrimitive.Indicator className="text-primary-foreground data-unchecked:hidden forced-colors:text-[HighlightText]">
                    <CheckIcon className="size-3.5" strokeWidth={3} />
                  </CheckboxPrimitive.Indicator>
                </CheckboxPrimitive.Root>
                <span className="min-w-0 flex-1 text-[0.9375rem] leading-normal">
                  <Markdown inline text={o.label} headingShift={4} className="text-[0.9375rem]" />
                </span>
              </label>
            ))}
          </div>
        )}

        {!isCheck && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids.reason}-text`} className="text-sm font-medium">
              Your explanation
            </label>
            <textarea
              id={`${ids.reason}-text`}
              data-first-control=""
              value={text}
              onChange={(e) => {
                setText(e.currentTarget.value);
                if (problem?.field === "text") setProblem(null);
              }}
              rows={4}
              aria-invalid={problem?.field === "text" || undefined}
              aria-describedby={problem?.field === "text" ? ids.error : undefined}
              className="min-h-24 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[0.9375rem] leading-relaxed outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 aria-invalid:border-destructive/60"
            />
          </div>
        )}

        <Confidence
          id={ids.conf}
          labelId={ids.confLabel}
          value={confidence}
          invalid={problem?.field === "confidence"}
          describedBy={problem?.field === "confidence" ? ids.error : undefined}
          onChange={(v) => {
            setConfidence(v);
            if (problem?.field === "confidence") setProblem(null);
          }}
        />

        {isCheck &&
          (showReason ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.reason} className="text-sm font-medium">
                Your reasoning <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id={ids.reason}
                value={thinking}
                onChange={(e) => setThinking(e.currentTarget.value)}
                rows={2}
                placeholder="Why you think so"
                className="min-h-16 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[0.9375rem] leading-relaxed outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
              />
            </div>
          ) : (
            <Button
              variant="ghost-muted"
              size="sm"
              className="-ms-2 self-start"
              onClick={() => {
                setShowReason(true);
                requestAnimationFrame(() => document.getElementById(ids.reason)?.focus());
              }}
            >
              <PlusIcon aria-hidden />
              Add your reasoning
            </Button>
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-4 py-3 sm:px-5">
        {problem ? (
          <p id={ids.error} role="alert" className="me-auto flex min-w-0 items-start gap-1.5 text-sm text-destructive-foreground">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>{problem.text}</span>
          </p>
        ) : (
          <span className="me-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex" aria-hidden>
            <KbdGroup>
              <Kbd>{modKey()}</Kbd>
              <Kbd>Enter</Kbd>
            </KbdGroup>
            to submit
          </span>
        )}
        <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={dontKnow}>
          I don’t know
        </Button>
        <Button type="submit" size="lg" disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter">
          <SendHorizontalIcon aria-hidden />
          {busy ? "Sending…" : "Submit answer"}
        </Button>
      </div>
    </form>
  );
}
