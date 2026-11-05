import { useFileViewer } from "@/components/viewer/file-viewer";
import { Icon } from "@/icons";
import { useActiveSpaceId, useSpaces } from "@/lib/spaces";
import type { MaterialSummary } from "@/lib/lms";

/** Surface the original document; OCR quality is secondary metadata, not a second report. */
export function MaterialFiles({ summary, space, folder = "" }: { summary?: MaterialSummary; space?: string; folder?: string }) {
  const file = useFileViewer();
  const active = useActiveSpaceId();
  const { spaces } = useSpaces();
  const context = space && active && active !== space ? spaces.find(s => s.id === space)?.name ?? space : null;
  if (!summary?.flagged.length) return null;
  return <>
    <details className="text-sm" data-material="flagged">
      <summary className="cursor-pointer py-1 text-ink-secondary">Source files <span className="text-ink-tertiary">{summary.flagged.length}</span>{context && <span className="ms-1 text-xs text-ink-tertiary" data-source-view-space={space}>· {context}</span>}</summary>
      <ul className="divide-y divide-line" data-material-files="">
        {summary.flagged.map(source => {
          const path = folder ? `${folder}/${source.path}` : source.path;
          const meta = [source.handwriting ? `${source.handwriting} scanned pages` : "", source.unreadable ? `${source.unreadable} pages need review` : "", source.pictures ? `${source.pictures} images` : ""].filter(Boolean).join(" · ");
          return <li key={source.path}>
            <button type="button" disabled={!space} onClick={() => space && file.open({ kind: "space", space, path })} className="flex w-full items-center gap-2 rounded-md py-2 text-start hover:bg-hover disabled:cursor-default" data-material-open={source.path}>
              <Icon name="file-text" className="shrink-0 text-ink-tertiary" />
              <span className="min-w-0 flex-1"><span className="block truncate text-ink">{source.path.split("/").pop()}</span><span className="block truncate text-xs text-ink-tertiary">{source.path}</span></span>
              <span className="max-w-[45%] text-end text-xs text-ink-secondary">{meta}</span>
              {space && <Icon name="chevron-right" className="size-3 shrink-0 text-ink-tertiary" />}
            </button>
          </li>;
        })}
      </ul>
    </details>
    {file.viewer}
  </>;
}
