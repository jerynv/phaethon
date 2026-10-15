import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import type { MaterialSummary } from "@/lib/lms";

/**
 * What a course's documents are made of, and the warning when the space's
 * model can't look at the pages that are handwriting or diagrams. Static
 * text (never live): it is read in order with the step or card it sits in.
 */

/** The warning (vision.rs's `Alert`), in a soft warning box with its icon. */
export function MaterialAlertNote({ alert, id }: { alert?: { kind: string; text: string }; id?: string }) {
  if (!alert) return null;
  return (
    <p
      id={id}
      className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm wrap-break-word text-ink forced-colors:border forced-colors:border-[CanvasText]"
      data-material-alert={alert.kind}
    >
      <Icon name="image-off" className="mt-0.5 shrink-0 text-warning-ink forced-colors:text-[CanvasText]" />
      <span className="min-w-0">{alert.text}</span>
    </p>
  );
}

/** A course's material report in sentences, with the documents it is about one fold below when asked. */
export function MaterialLines({ summary, className, details = false }: { summary?: MaterialSummary; className?: string; details?: boolean }) {
  if (!summary || summary.lines.length === 0) return null;
  const flagged = summary.handwritingPages + summary.unreadablePages + summary.pictures > 0;
  return (
    <div className={className} data-material={flagged ? "flagged" : "typed"}>
      <ul className="flex flex-col gap-0.5 text-sm text-ink-secondary">
        {summary.lines.map((l) => (
          <li key={l} className="flex items-start gap-1.5 wrap-break-word">
            <Icon name={flagged ? "image" : "file-text"} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{l}</span>
          </li>
        ))}
      </ul>
      {details && summary.flagged.length > 0 && (
        <Details summary={`Which files (${summary.flagged.length})`} className="mt-1">
          <ul className="flex flex-col gap-0.5 ps-5" data-material-files="">
            {summary.flagged.map((f) => (
              <li key={f.path} className="list-disc wrap-break-word">
                {f.path.split("/").pop()}: {fileWords(f)}
              </li>
            ))}
          </ul>
        </Details>
      )}
    </div>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function fileWords(f: MaterialSummary["flagged"][number]): string {
  const parts: string[] = [];
  if (f.handwriting) parts.push(`${plural(f.handwriting, "page", "pages")} of handwriting or scans${f.knownWords !== undefined ? ` (${Math.round(f.knownWords * 100)}% of words recognised as the course’s own)` : ""}`);
  if (f.unreadable) parts.push(`${plural(f.unreadable, "page", "pages")} that couldn’t be read`);
  if (f.pictures) parts.push(plural(f.pictures, "picture", "pictures"));
  return parts.join(", ");
}
