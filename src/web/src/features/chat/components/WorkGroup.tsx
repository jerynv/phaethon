import { CheckIcon, ChevronRightIcon, FilePenIcon, FileTextIcon, FolderTreeIcon, SearchIcon, SquareTerminalIcon, WrenchIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ToolCategory } from "#shared/agent.ts";
import { StartTruncate } from "@/components/truncate";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { workSummary, type ToolRecord } from "../lib/timeline";

const ICON: Record<ToolCategory, typeof FileTextIcon> = {
  read: FileTextIcon,
  list: FolderTreeIcon,
  search: SearchIcon,
  command: SquareTerminalIcon,
  write: FilePenIcon,
  other: WrenchIcon,
};

/** Consecutive tool steps folded into one line ("Read 3 files, searched twice"); open to see each step. */
export function WorkGroup({ tools, live }: { tools: ToolRecord[]; live: boolean }) {
  const running = tools.find((t) => t.status === "running");
  const [open, setOpen] = useState(false);
  const failed = tools.some((t) => t.status === "failed");
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/work -ml-1 flex h-6 max-w-full items-center gap-1.5 rounded-md px-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
      >
        {running && live ? <Spinner size="xs" /> : <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} strokeWidth={2.25} />}
        <span className={cn("min-w-0 truncate", running && live && "text-shimmer")}>{running && live ? running.label : workSummary(tools)}</span>
        {failed && !running ? <span className="size-1.5 shrink-0 rounded-full bg-error" /> : null}
      </button>
      {open ? (
        <ul className="mt-1 ml-1.5 flex flex-col gap-0.5 border-l pl-3">
          {tools.map((t) => {
            const Icon = ICON[t.category] ?? WrenchIcon;
            return (
              <li key={t.id} className="flex min-w-0 flex-col py-0.5">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="shrink-0 text-foreground/85">{t.label}</span>
                  {t.target ? <StartTruncate value={t.target} className="min-w-0 flex-1 font-mono text-2xs text-muted-foreground" /> : <span className="flex-1" />}
                  {t.status === "running" ? (
                    <Spinner size="xs" tone="muted" />
                  ) : t.status === "success" ? (
                    <CheckIcon className="size-3 shrink-0 text-subtle-foreground" strokeWidth={2.25} />
                  ) : t.status === "failed" ? (
                    <XIcon className="size-3 shrink-0 text-error" strokeWidth={2.25} />
                  ) : (
                    <span className="shrink-0 text-2xs text-subtle-foreground">{t.status === "cancelled" ? "stopped" : "unfinished"}</span>
                  )}
                </div>
                {t.detail ? <p className="mt-0.5 ml-5.5 line-clamp-3 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">{t.detail}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
