import { Passage, sourceWords } from "@/components/rich/citation";
import { Details } from "@/components/ui/details";
import { SpaceFileLink } from "@/components/viewer/file-viewer";
import { Icon } from "@/icons";
import type { Evidence, Grounding } from "@/lib/study";
import { citeName } from "@/lib/study-cite";

import { MathText } from "./card-text";
import { plural } from "./words";

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
