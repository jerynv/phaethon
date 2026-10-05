import { Dialog } from "radix-ui";
import { Settings as SettingsIcon, X } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { clearApiKey, getSettings, setApiKey, setBackend, type Backend, type Settings } from "@/lib/backend";

const BACKENDS: { value: Backend; label: string; hint: string }[] = [
  {
    value: "steward",
    label: "steward with your Anthropic API key",
    hint: "steward runs the agent itself. It sees only the space you are in, and asks before changing any file.",
  },
  {
    value: "claude-cli",
    label: "Claude Code on this computer",
    hint: "Uses the claude command you installed and logged into. Read-only for now.",
  },
];

/**
 * Vault settings: which agent runs, and the Anthropic API key. The key field is
 * write-only: once saved it goes to the system keychain and is never shown again.
 */
export function SettingsDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const keyId = useId();
  const keyHintId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) return;
    setStatus("");
    setError("");
    setKeyDraft("");
    getSettings().then(setSettings, (e: unknown) => setError(String(e)));
  }, [open]);

  async function act(work: () => Promise<void>, done: string) {
    setError("");
    setStatus("");
    try {
      await work();
      setSettings(await getSettings());
      setStatus(done);
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!keyDraft.trim()) {
      setError("Enter a key first.");
      return;
    }
    void act(async () => {
      await setApiKey(keyDraft);
      setKeyDraft("");
    }, "API key saved to the system keychain.");
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" className="w-full justify-start">
          <SettingsIcon aria-hidden="true" />
          Settings
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-background p-6 text-foreground shadow-lg">
          <Dialog.Title className="text-lg font-semibold">Settings</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            These apply to every space in this vault.
          </Dialog.Description>

          {settings && (
            <>
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 font-medium">Which agent answers</legend>
                {BACKENDS.map((b) => (
                  <label key={b.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border p-3">
                    <input
                      type="radio"
                      name="backend"
                      value={b.value}
                      checked={settings.backend === b.value}
                      onChange={() => void act(() => setBackend(b.value), `Now using ${b.label}.`)}
                      className="mt-1 size-4"
                    />
                    <span>
                      <span className="block">{b.label}</span>
                      <span className="block text-sm text-muted-foreground">{b.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <form onSubmit={saveKey} className="flex flex-col gap-2" aria-labelledby={`${keyId}-heading`}>
                <h3 id={`${keyId}-heading`} className="font-medium">
                  Anthropic API key
                </h3>
                <p id={keyHintId} className="text-sm text-muted-foreground">
                  {settings.hasAnthropicKey
                    ? "A key is saved in the system keychain. Enter a new one to replace it."
                    : "No key saved yet. Create one at console.anthropic.com. It is kept in the system keychain, never in your vault files."}
                </p>
                <label htmlFor={keyId} className="text-sm">
                  {settings.hasAnthropicKey ? "New API key" : "API key"}
                </label>
                <div className="flex gap-2">
                  <input
                    id={keyId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    aria-describedby={error ? `${keyHintId} ${errorId}` : keyHintId}
                    aria-invalid={error ? true : undefined}
                    className="min-h-10 flex-1 rounded-md border border-input bg-background px-3 py-2"
                  />
                  <Button type="submit" size="lg">
                    Save key
                  </Button>
                </div>
                {settings.hasAnthropicKey && (
                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    onClick={() => void act(clearApiKey, "API key removed from the keychain.")}
                  >
                    Remove saved key
                  </Button>
                )}
              </form>
              <p className="text-sm text-muted-foreground">Model: {settings.model}</p>
            </>
          )}

          <p role="status" className="text-sm">
            {status}
          </p>
          {error && (
            <p id={errorId} role="alert" className="rounded-md border-2 border-destructive px-3 py-2 text-sm">
              <strong>Error: </strong>
              {error}
            </p>
          )}

          <Dialog.Close asChild>
            <Button variant="ghost" size="icon" aria-label="Close settings" className="absolute top-3 right-3">
              <X aria-hidden="true" />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
