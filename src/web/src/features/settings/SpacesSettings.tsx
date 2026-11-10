import { ChevronLeftIcon, ChevronRightIcon, FolderOpenIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { SpaceView } from "@/app/api";
import { api } from "@/app/api";
import { HuePicker } from "@/app/HuePicker";
import { useNav } from "@/app/nav";
import { useShell } from "@/app/shell-store";
import { SpaceMark } from "@/app/SpaceMark";
import { descriptionProblem, hueName, nameProblem, useSpaces } from "@/app/spaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection } from "@/components/ui/settings";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core";
import { fileManagerName } from "@/lib/platform";

/** Spaces: a list; choosing one opens its editor (name, description, colour, school features, folder). */
export function SpacesSettings() {
  const spaces = useSpaces((s) => s.spaces);
  const status = useSpaces((s) => s.status);
  const [editing, setEditing] = useState<string | null>(null);
  const setNewSpaceOpen = useShell((s) => s.setNewSpaceOpen);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const space = spaces.find((s) => s.id === editing);

  // Back from an editor, focus returns to that space's row.
  useEffect(() => {
    if (editing === null && returnTo.current) {
      listRef.current?.querySelector<HTMLElement>(`[data-space-row="${returnTo.current}"]`)?.focus();
      returnTo.current = null;
    }
  }, [editing]);

  if (space) {
    return (
      <SpaceEditor
        space={space}
        onBack={() => {
          returnTo.current = space.id;
          setEditing(null);
        }}
      />
    );
  }

  return (
    <SettingsPage>
      <SettingsSection
        title="Your spaces"
        description="Each space has its own files, conversations and memory."
        action={
          <Button size="sm" variant="outline" onClick={() => setNewSpaceOpen(true)}>
            <PlusIcon />
            New space
          </Button>
        }
      >
        <div ref={listRef}>
          <SettingsGroup>
            {status === "loading" && spaces.length === 0
              ? [0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3.5" aria-hidden="true">
                    <Skeleton className="size-8 rounded-md" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3.5 w-48" />
                    </div>
                  </div>
                ))
              : spaces.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-space-row={s.id}
                    data-target=""
                    onClick={() => setEditing(s.id)}
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-start outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <SpaceMark name={s.name} hue={s.hue} className="size-8 text-sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-sm">{s.name}</span>
                      <span className="truncate text-muted-foreground text-sm">
                        {s.description || (s.educationEnabled ? "School features on" : "No description")}
                      </span>
                    </span>
                    {s.educationEnabled ? (
                      <span className="hidden shrink-0 rounded-full bg-[oklch(0.94_0.03_var(--mark-hue))] px-2 py-0.5 text-[oklch(0.42_0.11_var(--mark-hue))] text-xs sm:inline dark:bg-[oklch(0.3_0.045_var(--mark-hue))] dark:text-[oklch(0.84_0.08_var(--mark-hue))]" style={{ "--mark-hue": s.hue } as CSSProperties}>
                        School
                      </span>
                    ) : null}
                    <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
          </SettingsGroup>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

function SpaceEditor({ space, onBack }: { space: SpaceView; onBack(): void }) {
  const update = useSpaces((s) => s.update);
  const openSettings = useNav((s) => s.openSettings);
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { name: useId(), description: useId(), hue: useId(), education: useId() };
  const dirty = name.trim() !== space.name || description.trim() !== space.description;
  const nameError = nameProblem(name);
  const descriptionError = descriptionProblem(description);

  useEffect(() => headingRef.current?.focus(), []);

  async function save(patch: Parameters<typeof update>[1], done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await update(space.id, patch);
      if (done) {
        setMessage({ kind: "ok", text: done });
      }
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || nameError || descriptionError) return;
    void save({ name: name.trim(), description: description.trim() }, "Saved");
  }

  return (
    <SettingsPage>
      <div className="-mb-2 flex flex-col items-start gap-3">
        <Button size="sm" variant="ghost" className="-ms-2 text-muted-foreground" onClick={onBack}>
          <ChevronLeftIcon />
          Spaces
        </Button>
        <div className="flex items-center gap-3">
          <SpaceMark name={space.name} hue={space.hue} className="size-9 text-base" />
          <h3 ref={headingRef} tabIndex={-1} className="font-semibold text-lg outline-none">
            {space.name}
          </h3>
        </div>
      </div>

      <form onSubmit={submit} noValidate>
        <SettingsSection title="Name and description">
          <SettingsGroup>
            <div className="flex flex-col gap-4 px-4 py-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.name} className="font-medium text-sm">
                  Name
                </label>
                <Input
                  id={ids.name}
                  value={name}
                  maxLength={60}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? `${ids.name}-e` : undefined}
                  onValueChange={(v) => setName(String(v))}
                />
                {nameError ? (
                  <p id={`${ids.name}-e`} className="text-destructive-foreground text-sm">
                    {nameError}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.description} className="font-medium text-sm">
                  Description
                </label>
                <Input
                  id={ids.description}
                  value={description}
                  maxLength={160}
                  aria-invalid={descriptionError ? true : undefined}
                  aria-describedby={descriptionError ? `${ids.description}-e` : undefined}
                  onValueChange={(v) => setDescription(String(v))}
                />
                {descriptionError ? (
                  <p id={`${ids.description}-e`} className="text-destructive-foreground text-sm">
                    {descriptionError}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {dirty ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setName(space.name);
                      setDescription(space.description);
                    }}
                  >
                    Undo changes
                  </Button>
                ) : null}
                <Button type="submit" disabled={!dirty || busy || !!nameError || !!descriptionError}>
                  Save
                </Button>
              </div>
            </div>
          </SettingsGroup>
        </SettingsSection>
      </form>

      <p aria-live="polite" className={message?.kind === "error" ? "-my-4 px-1 text-destructive-foreground text-sm" : "-my-4 px-1 text-muted-foreground text-sm"}>
        {message?.text ?? ""}
      </p>

      <SettingsSection title="Look and features">
        <SettingsGroup>
          <SettingsRow title="Colour" labelId={ids.hue} description={hueName(space.hue)}>
            <HuePicker className="mt-3" value={space.hue} labelId={ids.hue} onValueChange={(hue) => void save({ hue }, `Colour: ${hueName(hue)}`)} />
          </SettingsRow>
          <SettingsRow
            title="School features"
            htmlFor={ids.education}
            description="Study, Grades, Plan and Courses beside the chat."
            control={
              <Switch
                id={ids.education}
                checked={space.educationEnabled}
                disabled={busy}
                onCheckedChange={(on) => void save({ educationEnabled: on }, on ? "School features on" : "School features off")}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Files and access">
        <SettingsGroup>
          <SettingsRow
            title="Space folder"
            description={`spaces/${space.id}`}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  api.showSpace(space.id).catch((e) => setMessage({ kind: "error", text: errorText(e) }))
                }
              >
                <FolderOpenIcon />
                Show in {fileManagerName()}
              </Button>
            }
          />
          <SettingsRow
            title="Coding agents"
            description="Working folder and full access for Claude Code, Codex and Gemini CLI."
            control={
              <Button variant="outline" size="sm" onClick={() => openSettings("agents")}>
                <TerminalIcon />
                Open
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
