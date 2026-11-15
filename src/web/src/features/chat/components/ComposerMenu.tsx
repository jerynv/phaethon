// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT. See THIRD_PARTY_NOTICES.md.
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "@/components/ui/command";
import { StartTruncate } from "@/components/truncate";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { FileIcon } from "@/features/viewer/FileIcon";
import { errorText, invoke } from "@/lib/core";
import type { ComposerCommand, Trigger } from "../lib/composer-menu";

/**
 * The list over the composer while `@` or `/` is being typed. The textarea
 * keeps focus and drives it (arrows, Enter, Tab, Esc), like T3 Code's; the
 * mouse can pick too.
 */

export type MenuItem = { id: string; kind: "file"; path: string } | { id: string; kind: "command"; command: ComposerCommand };

type Listed = { path: string; modified: number; size: number };
const cache = new Map<string, { at: number; files: Listed[] }>();

/** The space's files for `@`, fetched when a mention starts and reused for half a minute. */
export function useSpaceFiles(space: string, on: boolean): { files: Listed[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ files: Listed[]; loading: boolean; error: string | null }>(() => ({ files: cache.get(space)?.files ?? [], loading: false, error: null }));
  useEffect(() => {
    if (!on) return;
    const hit = cache.get(space);
    if (hit && Date.now() - hit.at < 30_000) {
      setState({ files: hit.files, loading: false, error: null });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    invoke<Listed[]>("space_files", { space }).then(
      (files) => {
        cache.set(space, { at: Date.now(), files });
        if (live) setState({ files, loading: false, error: null });
      },
      (e) => live && setState((s) => ({ ...s, loading: false, error: errorText(e) })),
    );
    return () => {
      live = false;
    };
  }, [space, on]);
  return state;
}

const COMMAND_ICON: Record<string, IconData> = {
  quiz: icons.quiz,
  explain: icons.teacher,
  socratic: icons.message,
  cram: icons.streak,
  normal: icons.chat,
  new: icons.newChat,
  model: icons.model,
  attach: icons.attach,
};

export function ComposerMenu({
  trigger,
  items,
  active,
  loading,
  error,
  onActive,
  onPick,
}: {
  trigger: Trigger;
  items: MenuItem[];
  active: number;
  loading: boolean;
  error: string | null;
  onActive: (i: number) => void;
  onPick: (item: MenuItem) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const label = trigger.kind === "mention" ? "Files in this space" : "Commands";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.1 } }}
      transition={{ type: "spring", duration: 0.22, bounce: 0.12 }}
      className="absolute inset-x-0 bottom-full z-20 mb-2 origin-bottom overflow-hidden rounded-xl border bg-popover shadow-popup"
      data-slot="composer-menu"
      data-kind={trigger.kind}
    >
      <Command autoHighlight={false} mode="none" items={items}>
        <div ref={list}>
          {items.length ? (
            <CommandList className="max-h-72 overflow-y-auto p-1" aria-label={label}>
              <CommandGroup items={items}>
                <CommandGroupLabel className="px-2 pt-1 pb-1.5 font-medium text-2xs text-muted-foreground">{label}</CommandGroupLabel>
                {items.map((item, i) => (
                  <CommandItem
                    key={item.id}
                    value={item}
                    data-index={i}
                    active={i === active}
                    onMouseMove={() => i !== active && onActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(item)}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-sm"
                  >
                    {item.kind === "file" ? <FileRow path={item.path} /> : <CommandRow command={item.command} />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          ) : (
            <p className="flex h-10 items-center gap-2 px-3 text-muted-foreground text-xs">
              {loading ? (
                <>
                  <Spinner size="xs" /> Looking through your files…
                </>
              ) : error ? (
                <span className="text-error-foreground">Couldn’t list the files: {error}</span>
              ) : trigger.kind === "mention" ? (
                "No file matches that name."
              ) : (
                "No command matches. Try /quiz, /new, /model or /attach."
              )}
            </p>
          )}
        </div>
      </Command>
    </motion.div>
  );
}

function FileRow({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash > 0 ? path.slice(0, slash) : "";
  return (
    <>
      <FileIcon name={name} className="size-4" />
      <span className="shrink-0 truncate font-medium">{name}</span>
      {dir ? <StartTruncate value={dir} className="min-w-0 text-muted-foreground text-xs" /> : null}
    </>
  );
}

function CommandRow({ command }: { command: ComposerCommand }) {
  const glyph = COMMAND_ICON[command.id] ?? icons.ai;
  return (
    <>
      <Icon icon={glyph} className="size-4 text-muted-foreground" />
      <span className="shrink-0 font-medium font-mono text-xs">/{command.label}</span>
      <span className="min-w-0 truncate text-muted-foreground text-xs">{command.hint}</span>
    </>
  );
}
