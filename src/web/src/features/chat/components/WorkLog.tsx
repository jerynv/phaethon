import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  FileTextIcon,
  FolderIcon,
  LoaderIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useNav } from "@/app/nav";
import { cn } from "@/lib/utils";
import { useSpaceId } from "../context";
import { workSummary, type ToolRecord } from "../lib/timeline";

const CATEGORY_ICON: Record<ToolRecord["category"], LucideIcon> = {
  read: FileTextIcon,
  list: FolderIcon,
  search: SearchIcon,
  command: TerminalIcon,
  write: PencilIcon,
  other: WrenchIcon,
};

const STATUS_WORD: Partial<Record<ToolRecord["status"], string>> = {
  failed: "Failed",
  cancelled: "Stopped",
  incomplete: "Didn’t finish",
};

/** A file a step read or changed opens in the viewer; anything else is just named. */
function Target({ tool }: { tool: ToolRecord }) {
  const space = useSpaceId();
  const openFile = useNav((s) => s.openFile);
  const target = tool.target!;
  const isFile = (tool.category === "read" || tool.category === "write") && !target.startsWith("@") && /\.[A-Za-z0-9]{1,8}$/.test(target);
  if (!isFile || tool.status === "failed") return <span className="ms-1.5 font-mono text-[0.8125rem] text-foreground wrap-anywhere">{target}</span>;
  return (
    <button
      type="button"
      onClick={() => openFile(target, space)}
      className="ms-1.5 cursor-pointer rounded-sm font-mono text-[0.8125rem] text-foreground underline decoration-foreground/30 underline-offset-2 wrap-anywhere hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {target}
    </button>
  );
}

function ToolRow({ tool }: { tool: ToolRecord }) {
  const Icon = tool.status === "running" ? LoaderIcon : CATEGORY_ICON[tool.category];
  const word = STATUS_WORD[tool.status];
  return (
    <li className="flex min-w-0 items-start gap-2 py-0.5" data-tool-state={tool.status}>
      <span aria-hidden className="flex h-6 w-5 shrink-0 items-center justify-center">
        <Icon
          className={cn(
            "size-3.5",
            tool.status === "running" && "animate-spin text-foreground motion-reduce:animate-none",
            tool.status === "failed" ? "text-destructive" : tool.status !== "running" && "text-muted-foreground",
          )}
        />
      </span>
      <span className="min-w-0 flex-1 py-0.5 text-sm leading-5">
        <span className="text-muted-foreground">{tool.label}</span>
        {tool.target && !tool.label.includes(tool.target) && <Target tool={tool} />}
        {tool.detail && <span className="block text-[0.8125rem] text-muted-foreground wrap-anywhere">{tool.detail}</span>}
      </span>
      {tool.status === "success" && <CheckIcon aria-label="Done" className="mt-1 size-3.5 shrink-0 text-muted-foreground/70" />}
      {word && (
        <span className={cn("mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs", tool.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {tool.status === "failed" ? <XIcon aria-hidden className="size-3" /> : <CircleSlashIcon aria-hidden className="size-3" />}
          {word}
        </span>
      )}
    </li>
  );
}

/**
 * The tool work of a reply, gathered: one line that says what is happening
 * (or, once done, what was done), opening into every step. Open while it
 * runs, folded after, unless the person chose otherwise.
 */
export function WorkLog({ tools, live, status }: { tools: ToolRecord[]; live: boolean; status?: string }) {
  const panelId = useId();
  const running = tools.find((t) => t.status === "running");
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? false;
  const current = running ? [running.label, running.target].filter(Boolean).join(" ") : null;
  const headline = live && (status || current) ? (status ?? current!) : workSummary(tools);
  return (
    <div className="ph-block" data-work-log="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setChosen(!open)}
        className="group -ms-1 flex min-h-7 max-w-full items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {live && running ? (
          <LoaderIcon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <WrenchIcon aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{headline}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          · {tools.length} {tools.length === 1 ? "step" : "steps"}
        </span>
        <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      </button>
      <div id={panelId} hidden={!open}>
        <ol aria-label="Steps" className="ms-1 mt-1 flex max-h-72 flex-col overflow-y-auto overscroll-contain border-s ps-2.5">
          {tools.map((t) => (
            <ToolRow key={t.id} tool={t} />
          ))}
        </ol>
      </div>
    </div>
  );
}
