import { RadioGroup } from "radix-ui";
import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import { clearApiKey, setApiKey, setBackend, type Backend, type Settings } from "@/lib/backend";

import { SectionHeader, SettingGroup, SettingRow } from "./controls";

const BACKENDS: { value: Backend; label: string; hint: string }[] = [
  {
    value: "phaethon",
    label: "Phaethon, with your Anthropic API key",
    hint: "Phaethon runs the agent itself. It sees only the space you are in, and asks before changing any file.",
  },
  {
    value: "claude-cli",
    label: "Claude Code on this computer",
    hint: "Uses the claude command you installed and logged into yourself. Read-only for now.",
  },
];

/**
 * Which agent answers, and the Anthropic API key. The key field is write-only:
 * once saved it goes to the system keychain and is never shown again.
 */
export function AgentSection({
  headingId,
  settings,
  act,
}: {
  headingId: string;
  settings: Settings | null;
  /** Run a change, then reload settings and announce `done`; errors are shown by the window. */
  act: (work: () => Promise<void>, done: string) => Promise<boolean>;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState("");
  const backendLabel = useId();
  const keyId = useId();
  const keyHintId = useId();
  const keyErrorId = useId();

  function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!keyDraft.trim()) {
      setKeyError("Paste a key first. It starts with sk-ant-.");
      return;
    }
    setKeyError("");
    void act(async () => {
      await setApiKey(keyDraft);
      setKeyDraft("");
    }, "API key saved to the system keychain.");
  }

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Agent"
        description="Which agent answers in your spaces, and the key it uses. These apply to every space in this vault."
      />
      {!settings ? (
        <p className="text-base text-ink-secondary" role="status">
          Loading your agent settings…
        </p>
      ) : (
        <>
          <SettingGroup title="Which agent answers" bare>
            <div>
              <span id={backendLabel} className="sr-only">
                Which agent answers
              </span>
              <RadioGroup.Root
                aria-labelledby={backendLabel}
                value={settings.backend}
                onValueChange={(v) => {
                  const b = BACKENDS.find((x) => x.value === v)!;
                  void act(() => setBackend(b.value), `Now using ${b.label}.`);
                }}
                className="flex flex-col gap-2"
              >
                {BACKENDS.map((b) => (
                  <RadioGroup.Item
                    key={b.value}
                    value={b.value}
                    aria-describedby={`${backendLabel}-${b.value}`}
                    className={cn(
                      "group flex w-full min-w-0 items-start gap-3 rounded-lg border border-line-strong bg-raised px-4 py-3 text-left shadow-sm transition-colors duration-(--ph-duration-fast) hover:bg-hover",
                      "data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-soft",
                    )}
                  >
                    <span className="mt-0.5 grid size-(--ph-icon-size) shrink-0 place-items-center rounded-full border-2 border-ink-tertiary group-data-[state=checked]:border-accent-fill">
                      <RadioGroup.Indicator className="size-2 rounded-full bg-accent-fill" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-base font-medium text-ink">{b.label}</span>
                      <span id={`${backendLabel}-${b.value}`} className="text-sm text-ink-secondary group-data-[state=checked]:text-accent-soft-ink">
                        {b.hint}
                      </span>
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </div>
          </SettingGroup>

          <SettingGroup title="Anthropic API key" description="Only used when Phaethon runs the agent itself.">
            <form onSubmit={saveKey} className="flex flex-col gap-3 px-4 py-3.5" aria-label="Anthropic API key">
              <p id={keyHintId} className="flex items-start gap-2 text-sm text-ink-secondary">
                <Icon name={settings.hasAnthropicKey ? "lock" : "key"} className="mt-0.5 text-ink-tertiary" />
                <span>
                  {settings.hasAnthropicKey
                    ? "A key is saved in this computer's keychain. Phaethon never shows it again; enter a new one to replace it."
                    : "No key saved yet. Create one at console.anthropic.com. It goes into this computer's keychain, never into your vault files, so it never syncs."}
                </span>
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={keyId} className="text-base font-medium text-ink">
                  {settings.hasAnthropicKey ? "New API key" : "API key"}
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id={keyId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-ant-…"
                    value={keyDraft}
                    onChange={(e) => {
                      setKeyDraft(e.target.value);
                      if (keyError) setKeyError("");
                    }}
                    aria-describedby={keyError ? `${keyHintId} ${keyErrorId}` : keyHintId}
                    aria-invalid={keyError ? true : undefined}
                    className="min-h-(--ph-control-height-lg) min-w-(--ph-settings-label-min) flex-1 rounded-md border border-line-strong bg-bg px-3 py-1.5 font-mono text-base text-ink placeholder:text-ink-tertiary aria-invalid:border-danger"
                  />
                  <Button type="submit">Save key</Button>
                </div>
                {keyError && (
                  <p id={keyErrorId} className="flex items-center gap-1.5 text-sm text-danger-ink">
                    <Icon name="error" className="size-(--ph-icon-size-sm)" />
                    {keyError}
                  </p>
                )}
              </div>
              {settings.hasAnthropicKey && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => void act(clearApiKey, "API key removed from the keychain.")}
                >
                  <Icon name="remove" />
                  Remove saved key
                </Button>
              )}
            </form>
          </SettingGroup>

          <SettingGroup title="Model">
            <SettingRow label="Model" description="Set per vault in .phaethon/settings.json. A picker is coming.">
              <span className="font-mono text-sm text-ink">{settings.model}</span>
            </SettingRow>
          </SettingGroup>
        </>
      )}
    </>
  );
}
