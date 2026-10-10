import type { DataMessagePartComponent } from "@assistant-ui/react";
import { useContext, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/icons";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { openSpaceFile, type AccessAnswer, type ChatRecord, type RecordPartData } from "@/runtime/records";

import { SpacePath, spaceInfo } from "./access-request-card";
import { SpaceIdContext } from "./approval-card";

const ACCESS: Record<AccessAnswer, { verb: string; icon: IconName }> = {
  once: { verb: "Allowed once", icon: "check" },
  always: { verb: "Always allowed", icon: "check" },
  deny: { verb: "Not allowed", icon: "close" },
};

const where = (space: string, path: string) => {
  const { name } = spaceInfo(space);
  const clean = path.replace(/\/+$/, "");
  return clean ? `${name} / ${clean}` : `all of ${name}`;
};

/** A record in words, as the status region says it ("Allowed: create plans/week6.md"). */
export function recordText(r: ChatRecord): string {
  switch (r.kind) {
    case "approval":
      return `${r.allowed ? "Allowed" : "Not allowed"}: ${r.action} ${r.path}`;
    case "access":
      return `${ACCESS[r.answer].verb}: ${where(r.space, r.path)}`;
    case "read":
      return r.tool === "search"
        ? `Searched ${where(r.space, r.path)}${r.query ? ` for “${r.query}”` : ""}`
        : `${r.tool === "list" ? "Listed" : "Read"} ${where(r.space, r.path)}`;
    case "stopped":
      return "Reply stopped";
  }
}

/** Whether a record is news to announce when it arrives (reads are announced as activity already). */
export const announcesRecord = (r: ChatRecord) => r.kind === "approval" || r.kind === "access";

/** "Show in Finder" in each platform's own words. */
export const revealLabel = () =>
  platform() === "mac" ? "Show in Finder" : platform() === "windows" ? "Show in File Explorer" : "Show in folder";

/**
 * A file Phaethon wrote, as a link that opens it in its default app, with a
 * second, quieter way to show it in the file manager. A failure says why, here.
 */
function FileLink({ path }: { path: string }) {
  const space = useContext(SpaceIdContext);
  const [problem, setProblem] = useState("");
  const open = async (reveal: boolean) => {
    setProblem("");
    try {
      await openSpaceFile(space, path, reveal);
    } catch (e) {
      setProblem(`${path} couldn’t be ${reveal ? "shown" : "opened"}: ${String(e)}`);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="link"
        size="xs"
        data-file-open={path}
        className="min-w-0 font-mono text-sm underline decoration-1 underline-offset-2 wrap-anywhere hover:decoration-2"
        onClick={() => void open(false)}
      >
        {path}
        <span className="sr-only">, open</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-file-reveal={path}
        className="text-ink-secondary hover:text-ink"
        onClick={() => void open(true)}
      >
        <Icon name="folder" />
        {revealLabel()}
        <span className="sr-only">: {path}</span>
      </Button>
      {problem && (
        <span role="alert" className="basis-full text-danger-ink">
          {problem}
        </span>
      )}
    </>
  );
}

/**
 * One line in a reply that says what happened and stays: a write the user
 * allowed or not (with the file, once written, a link), an access answer,
 * a read in another space, a stopped reply. Live replies show each where it
 * happened; a reloaded reply lists them after its text. Quiet lines, not cards.
 */
export function RecordLine({ record }: { record: ChatRecord }) {
  const box = "my-4 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface px-2.5 py-1 text-sm text-ink-secondary first:mt-0";
  const mark = (icon: IconName, ok?: boolean) => (
    <Icon name={icon} className={cn("size-(--ph-icon-size-sm) shrink-0", ok ? "text-success-ink" : "text-ink-secondary")} />
  );
  switch (record.kind) {
    case "approval":
      return (
        <p className={box} data-record="approval" data-allowed={record.allowed ? "true" : "false"}>
          {mark(record.allowed ? "check" : "close", record.allowed)}
          <span className="shrink-0">
            {record.allowed ? "Allowed" : "Not allowed"}: {record.action}
          </span>
          {record.allowed ? (
            <FileLink path={record.path} />
          ) : (
            <span className="min-w-0 font-mono text-ink wrap-anywhere">{record.path}</span>
          )}
        </p>
      );
    case "access": {
      const a = ACCESS[record.answer];
      const clean = record.path.replace(/\/+$/, "");
      return (
        <p className={box} data-record="access" data-access-receipt={record.answer}>
          {mark(a.icon, record.answer !== "deny")}
          <span className="shrink-0">{a.verb}:</span>
          {clean ? (
            <SpacePath space={record.space} path={record.path} />
          ) : (
            <span>
              all of <SpacePath space={record.space} path="" />
            </span>
          )}
          {record.answer === "always" && <span className="sr-only">. You can remove it in Settings, Spaces.</span>}
          {record.answer === "deny" && <span className="sr-only">. Phaethon won’t ask for it again in this conversation.</span>}
        </p>
      );
    }
    case "read": {
      const verb = record.tool === "search" ? "Searched" : record.tool === "list" ? "Listed" : "Read";
      return (
        <p className={box} data-record="read">
          {mark(record.tool === "search" ? "search" : record.tool === "list" ? "folder" : "file-text")}
          <span className="shrink-0">{verb}</span>
          <SpacePath space={record.space} path={record.path} />
          {record.tool === "search" && record.query && <span className="min-w-0 wrap-anywhere">for “{record.query}”</span>}
        </p>
      );
    }
    case "stopped":
      return (
        <p className={cn(box, "border-transparent bg-transparent px-0")} data-record="stopped">
          {mark("stop")}
          Reply stopped.
        </p>
      );
  }
}

/** A record as a data part of a reply (see RECORD_PART). */
export const RecordPart: DataMessagePartComponent<RecordPartData> = (props) => {
  const data: RecordPartData = props.data;
  return <RecordLine record={data.record} />;
};
