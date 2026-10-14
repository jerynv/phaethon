import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Passage, sourceWords } from "@/components/rich/citation";
import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Input } from "@/components/ui/input";
import { SpaceFileLink } from "@/components/viewer/file-viewer";
import { Icon } from "@/icons";
import { studyScopeState, type Evidence, type Grounding, type UnknownScope } from "@/lib/study";
import { citeName } from "@/lib/study-cite";

import { MathText } from "./card-text";
import { plainError, plural } from "./words";

/** Asking what an exam covers, in the same words wherever it is asked (the chat card, the make dialog). */
export const scopeQuestion = (exam: string) => `What does ${exam} cover?`;
export const scopeHint = (courseName: string) =>
  `As your instructor said it, for example “through HW 6, not graphs or combinatorics”. It’s kept for ${courseName} and shown as yours.`;
export const scopeMissing = (exam: string) => `Say what ${exam} covers, in a few words.`;

/** The exam's scope wasn't found when making it: say it, it is kept for the course, and it is made from that. */
export function ScopeForm({ space, needs, onSaved }: { space: string; needs: UnknownScope; onSaved: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) {
      setProblem(scopeMissing(needs.exam));
      ref.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await studyScopeState(space, needs.course, needs.exam, text.trim());
      announce(`Saved what ${needs.exam} covers. Making it now.`);
      onSaved();
    } catch (err) {
      setProblem(plainError(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-1.5" data-scope-form="">
      <label htmlFor={`${id}-scope`} className="text-base font-medium text-ink">
        {scopeQuestion(needs.exam)}
      </label>
      <p id={`${id}-hint`} className="text-sm text-ink-secondary">
        {scopeHint(needs.courseName)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={ref}
          id={`${id}-scope`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setProblem("");
          }}
          aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ""}`}
          aria-invalid={!!problem || undefined}
          className="max-w-md min-w-0 flex-1"
        />
        <Button type="submit" disabled={saving} data-scope-save="">
          {saving ? <Icon name="spinner" className="animate-spin" /> : <Icon name="check" />}
          Save and make it
        </Button>
      </div>
      {problem && (
        <p id={`${id}-problem`} className="text-sm text-danger-ink">
          {problem}
        </p>
      )}
    </form>
  );
}

/** Where an exam's scope comes from: each passage, with its file one click away; the person's own word said as theirs. */
export function ScopeEvidence({ space, evidence }: { space: string; evidence: Evidence[] }) {
  return (
    <>
      {evidence.map((e, i) => (
        <div key={i} className="flex flex-col gap-1" data-scope-evidence={e.source === "from you" ? "you" : "file"}>
          <p className="text-sm text-ink-secondary">{e.source === "from you" ? "You said:" : `${sourceWords(e)}:`}</p>
          <Passage passage={e.quote} />
          {e.source !== "from you" && (
            <SpaceFileLink space={space} path={e.source} className="inline-flex min-h-(--ph-target-min) items-center gap-1.5 text-sm">
              <Icon name="file-text" className="size-(--ph-icon-size-sm)" />
              Open {citeName(e.source)}
            </SpaceFileLink>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * What a quiz or deck was made against, for its header: the exam's scope in
 * words with its evidence one fold below; then, when something fell short,
 * why, in words; then which topics it covers (and why any got none) and what
 * was left out by the check.
 */
export function GroundingSummary({ space, g, noun = "question" }: { space: string; g: Grounding; noun?: "question" | "card" }) {
  const notes = g.notes ?? [];
  const covered = g.coverage.filter((c) => c.count > 0).length;
  return (
    <section aria-label="What this was made from" className="flex flex-col gap-1.5" data-grounding="">
      {g.exam && (
        <p className="flex items-start gap-2 text-base text-ink" data-scope-line="">
          <Icon name="book" className="mt-0.5 shrink-0 text-ink-secondary" />
          <span className="min-w-0 wrap-break-word">
            <span className="font-semibold">{g.exam}:</span> {g.scope || "its topics"}
            {g.fromUser && <span className="text-ink-secondary"> (as you said)</span>}
          </span>
        </p>
      )}
      {g.exam && g.evidence.length > 0 && (
        <Details summary={g.fromUser ? "What you said it covers" : `Where ${g.exam}’s scope comes from`}>
          <ScopeEvidence space={space} evidence={g.evidence} />
        </Details>
      )}
      {notes.map((n) => (
        <p key={n} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-base text-ink" data-grounding-note="">
          <Icon name="info" className="mt-0.5 shrink-0 text-warning-ink" />
          <span className="min-w-0 wrap-break-word">{n}</span>
        </p>
      ))}
      {g.coverage.length > 0 && (
        <Details summary={`What it covers: ${covered} of ${plural(g.coverage.length, "topic")}`}>
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm text-ink" data-coverage="">
            {g.coverage.map((c) => (
              <li key={c.topic}>
                {c.topic}
                {c.sections ? ` (${c.sections})` : ""}: {c.count > 0 ? plural(c.count, noun) : <span className="text-ink-secondary">none, {c.why ?? "none were kept"}</span>}
              </li>
            ))}
          </ul>
        </Details>
      )}
      {g.dropped.length > 0 && (
        <Details summary={`Left out by the check: ${g.dropped.length}`}>
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm text-ink" data-dropped="">
            {g.dropped.map((d, i) => (
              <li key={i}>
                {d.text ? (
                  <>
                    “<MathText text={d.text} />”: {d.why}
                  </>
                ) : (
                  d.why
                )}
              </li>
            ))}
          </ul>
        </Details>
      )}
    </section>
  );
}
