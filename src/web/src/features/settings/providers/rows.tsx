import { useEffect, useState } from "react";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, Row, Status } from "../ui";
import {
  checkApiKey,
  clearApiKey,
  type ProviderInfo,
  type ServerStatus,
  type Settings,
  setAnthropicModel,
  setApiKey,
  setProviderModel,
  setProviderUrl,
} from "./api";
import { ModelChooser } from "./ModelChooser";
import { canSaveUnchecked, checkAndSave, type KeyOutcome, keyExpiry, outcomeText, providerModel, providerNeed } from "./logic";

/**
 * The rows a key-based service opens to in Settings › AI & Models
 * (models/ModelsSection.tsx): its key (checked, then saved; a saved key is
 * never shown again), its address where that's editable, a local server's
 * status, and its default model.
 */

export type Server = ServerStatus | "checking" | { error: string } | null;

const host = (url: string) => {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
};

/** For services whose "key" is a sign-in token: where it comes from, and the link's words. */
const TOKEN_KEYS: Record<string, { link: string; hint: string }> = {
  reallms: {
    link: "Sign in at",
    hint: "After you sign in, open your browser’s developer tools and copy the token from Application › Local Storage. It starts with eyJ and lasts 7 days, then you paste a new one here.",
  },
};

export function KeyRow({ p, autoFocus, onChanged }: { p: ProviderInfo; autoFocus?: boolean; onChanged: () => Promise<void> }) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"check" | "save" | "remove" | null>(null);
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const [confirm, setConfirm] = useState(false);
  const editing = !p.hasKey || replacing;
  const id = `key-${p.id}`;
  const token = TOKEN_KEYS[p.id];
  const expiry = keyExpiry(p.keyExpiresAt);

  const submit = async (skipCheck = false) => {
    setBusy(skipCheck ? "save" : "check");
    setOutcome(null);
    const o = await checkAndSave(value, p.id, { check: checkApiKey, save: setApiKey }, skipCheck);
    setBusy(null);
    if (o.kind === "saved" || o.kind === "no-credit") {
      setValue("");
      setReplacing(false);
      setOutcome(o.kind === "no-credit" ? o : null);
      await onChanged();
      return;
    }
    setOutcome(o);
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await clearApiKey(p.id);
      setOutcome(null);
      await onChanged();
    } catch (e) {
      toast.error("Couldn’t remove the key", cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!editing) {
    return (
      <Row
        label="API key"
        description={
          <span className="flex items-center gap-2">
            <span aria-hidden className="tracking-tight">••••••••</span>
            {expiry?.tone === "error" ? null : <Status tone="ready">Saved</Status>}
            {expiry ? <Status tone={expiry.tone}>{expiry.text}</Status> : null}
          </span>
        }
        below={
          outcome?.kind === "no-credit" ? (
            <p className="text-warning-foreground text-xs">{outcomeText(outcome, p)}</p>
          ) : expiry && expiry.tone !== "ready" ? (
            <p className="text-muted-foreground text-xs">
              {expiry.tone === "error" ? `${p.name} stops answering until you replace the key.` : "Replace it soon to keep chats answering."}
            </p>
          ) : undefined
        }
      >
        <Button size="xs" variant="ghost" onClick={() => setReplacing(true)}>
          Replace
        </Button>
        <Button size="xs" variant="ghost-destructive" onClick={() => setConfirm(true)} pending={busy === "remove"}>
          Remove
        </Button>
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove your ${p.name} key?`} confirm="Remove key" destructive onConfirm={() => void remove()}>
          <p>Phaethon deletes it from this computer’s keychain. Conversations that use {p.name} stop answering until you add a key again.</p>
        </ConfirmDialog>
      </Row>
    );
  }

  const problem = outcome?.kind === "problem" ? outcome : null;
  return (
    <Field
      label="API key"
      htmlFor={id}
      aside={
        p.keysUrl ? (
          <a href={p.keysUrl} target="_blank" rel="noreferrer noopener" className="text-primary text-xs hover:underline">
            {token?.link ?? "Get a key at"} {host(p.keysUrl)}
          </a>
        ) : p.key === "optional" ? (
          <span className="text-subtle-foreground text-xs">Only if your server asks for one</span>
        ) : undefined
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          id={id}
          type="password"
          autoFocus={autoFocus || replacing}
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={problem ? true : undefined}
          size="sm"
          placeholder={p.keyPrefix ? `${p.keyPrefix}…` : "Paste your key"}
          onChange={(e) => {
            setValue(e.target.value);
            if (problem) setOutcome(null);
          }}
          className="font-mono"
        />
        {replacing ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setReplacing(false);
              setValue("");
              setOutcome(null);
            }}
          >
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="xs" disabled={busy !== null && busy !== "check"} pending={busy === "check"}>
          Check and save
        </Button>
      </form>
      {token ? <p className="text-muted-foreground text-xs">{token.hint}</p> : null}
      {busy === "check" ? (
        <p role="status" className="text-muted-foreground text-xs">
          Asking {p.name} whether the key works…
        </p>
      ) : null}
      {problem ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <FieldError>{outcomeText(problem, p)}</FieldError>
          {canSaveUnchecked(problem) ? (
            <button type="button" className="font-medium text-foreground text-xs hover:underline disabled:opacity-60" disabled={busy !== null} onClick={() => void submit(true)}>
              {busy === "save" ? "Saving…" : "Save without checking"}
            </button>
          ) : null}
        </div>
      ) : null}
    </Field>
  );
}

export function UrlRow({ p, onChanged }: { p: ProviderInfo; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState(p.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(p.baseUrl), [p.baseUrl]);
  const id = `url-${p.id}`;
  const dirty = draft.trim() !== p.baseUrl;
  const save = async (url: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await setProviderUrl(p.id, url);
      await onChanged();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label="Server address" htmlFor={id}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save(draft.trim() || null);
        }}
      >
        <Input
          id={id}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          size="sm"
          placeholder={p.defaultBaseUrl || "https://example.com/v1"}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          className="font-mono"
        />
        {dirty ? (
          <Button type="submit" size="xs" pending={busy}>
            Save
          </Button>
        ) : p.defaultBaseUrl && p.baseUrl !== p.defaultBaseUrl ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void save(null)}>
            Reset
          </Button>
        ) : null}
      </form>
      <FieldError>{error}</FieldError>
    </Field>
  );
}

export function ServerRow({ p, server, onCheck }: { p: ProviderInfo; server: Server; onCheck: () => void }) {
  const checking = server === "checking";
  const message = !server || checking ? null : "error" in server ? server.error : server.message;
  const running = !!server && !checking && !("error" in server) && server.running;
  return (
    <Row
      label="Server"
      description={
        checking ? (
          `Looking for ${p.name}…`
        ) : message ? (
          <span className={cn("[overflow-wrap:anywhere]", !running && "text-foreground/80")}>{message}</span>
        ) : (
          "Not checked yet"
        )
      }
    >
      <Button size="xs" variant="outline" onClick={onCheck} disabled={checking} className="min-w-24">
        {checking ? <Spinner /> : <Icon icon={icons.retry} />}
        {checking ? "Checking…" : "Check again"}
      </Button>
    </Row>
  );
}

export function ModelRow({ p, settings, onChanged }: { p: ProviderInfo; settings: Settings; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const need = providerNeed(p, settings);
  const blocked = need?.field === "key" || need?.field === "url";
  const current = providerModel(p, settings);
  const choose = async (model: string) => {
    setBusy(true);
    setError(null);
    try {
      if (p.id === "anthropic") await setAnthropicModel(model);
      else await setProviderModel(p.id, model);
      await onChanged();
    } catch (e) {
      setError(`Couldn’t save the model: ${cleanMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Default model"
      description={blocked ? (need?.field === "key" ? "Add a key to see the models." : "Add the address to see the models.") : "For chats that don’t name a model."}
      below={error ? <FieldError>{error}</FieldError> : undefined}
    >
      {busy ? <Spinner size="sm" tone="muted" /> : null}
      <ModelChooser provider={p} current={blocked ? null : current} disabled={blocked || busy} onChoose={(m) => void choose(m)} />
    </Row>
  );
}
