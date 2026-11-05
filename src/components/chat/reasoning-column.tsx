import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import type { CliId } from "@/lib/space-model";

export type ReasoningTarget = { account: string; cli: CliId; model: string | null; name: string; levels: readonly string[]; focus: boolean };
export const effortLabel = (level: string) => ({ xhigh: "Extra high", minimal: "Minimal", none: "None" }[level] ?? level.charAt(0).toUpperCase() + level.slice(1));

/** T3's docked effort column, using Vic buttons and provider-reported choices. */
export function ReasoningColumn({ target, spaceId, busy, onBusyChange, onSaved, onBack, onRequestClose }: {
  target: ReasoningTarget; spaceId: string; busy: boolean; onBusyChange: (busy: boolean) => void;
  onSaved: (value: string | null) => void; onBack: () => void; onRequestClose: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (saving || busy || !restore.current) return;
    ref.current?.querySelector<HTMLButtonElement>(`[data-effort-level="${CSS.escape(restore.current)}"]`)?.focus();
    restore.current = null;
  }, [saving, busy]);
  useEffect(() => {
    let active = true;
    void invoke<string | null>("space_reasoning_get", { space: spaceId, cli: target.cli, model: target.model }).then(result => {
      if (active) { setValue(result); setLoading(false); }
    }, reason => { if (active) { setError(String(reason)); setLoading(false); } });
    return () => { active = false; };
  }, [spaceId, target.cli, target.model]);
  useEffect(() => {
    if (!loading && target.focus) ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [loading, target.focus]);
  async function choose(next: string | null) {
    if (loading || saving || busy) return;
    restore.current = next ?? "default";
    setSaving(true); setError(""); onBusyChange(true);
    try {
      await invoke("space_reasoning_set", { space: spaceId, cli: target.cli, model: target.model, effort: next });
      setValue(next); onSaved(next); announce(`Reasoning: ${next ? effortLabel(next) : "Default"}.`);
    } catch (reason) { setError(`Reasoning couldn’t be saved. ${String(reason)}`); }
    finally { setSaving(false); onBusyChange(false); }
  }
  return <div ref={ref} className="ph-model-effort" data-model-picker-effort="" aria-busy={loading || saving}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onRequestClose(); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); onBack(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-effort-level]:not(:disabled)')];
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault(); rows[next]?.focus();
    }}>
    <div className="ph-model-effort-heading"><span title={target.name}>{target.name}</span><span>Reasoning</span></div>
    <div role="radiogroup" aria-label={`Reasoning for ${target.name}`}>
      {[null, ...target.levels].map(level => <Button key={level ?? "default"} type="button" variant="ghost" size="sm"
        role="radio" aria-checked={value === level} tabIndex={value === level || (level === null && !target.levels.includes(value ?? "")) ? 0 : -1} disabled={loading || saving || busy}
        data-effort-level={level ?? "default"} className="ph-model-effort-row" onClick={() => void choose(level)}>
        <span>{level === null ? "Default" : effortLabel(level)}</span>{value === level && <Icon name="check" className="size-3.5" />}
      </Button>)}
    </div>
    {error && <p role="alert" className="ph-model-error">{error}</p>}
  </div>;
}
