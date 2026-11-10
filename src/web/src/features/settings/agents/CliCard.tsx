/**
 * One coding-agent CLI: whether it's installed (with how to install it), and
 * its accounts (instances, each its own home), each with the CLI's own
 * sign-in. Visual reference: T3 Code's ProviderInstanceCard (list mode) and
 * ProviderAuthenticationSection.
 */
import { CheckIcon, CopyIcon, EllipsisIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { ProviderLogo } from "../providers/ProviderLogo";
import { Dot, ExternalLink, FieldMessage } from "../providers/ui";
import { CLI_INFO, removeInstance, selectInstance, signOutInstance, type CliId, type CliStatus, type InstanceView } from "./api";
import { instanceStatus, useAgents } from "./store";

export function CliCard({
  cli,
  status,
  instances,
  answering,
  onAddAccount,
  onEditAccount,
  onUsage,
  onSaid,
}: {
  cli: CliId;
  status: CliStatus | undefined;
  instances: InstanceView[];
  answering: boolean;
  onAddAccount: (cli: CliId) => void;
  onEditAccount: (instance: InstanceView) => void;
  onUsage: (instance: InstanceView) => void;
  onSaid: (text: string) => void;
}) {
  const info = CLI_INFO[cli];
  const load = useAgents((s) => s.load);
  const installed = status?.installed ?? instances.some((i) => i.installed);
  const headingId = `cli-${cli}-name`;

  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
          <ProviderLogo id={`${cli}-cli`} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h4 id={headingId} className="text-[0.9375rem] font-semibold">
              {info.name}
            </h4>
            {answering ? (
              <Badge variant="info" size="lg">
                Answering
              </Badge>
            ) : null}
          </div>
          <span className="text-sm text-muted-foreground">{installed ? `By ${info.company}` : "Not installed"}</span>
        </div>
        {installed ? (
          <Button variant="ghost" size="sm" onClick={() => onAddAccount(cli)}>
            <PlusIcon />
            <span className="max-sm:sr-only">Add account</span>
            <span className="sr-only"> to {info.name}</span>
          </Button>
        ) : null}
      </div>
      {installed ? (
        <ul aria-label={`${info.name} accounts`} className="border-t [&>li+li]:border-t">
          {instances.map((i) => (
            <AccountRow key={i.config.id} instance={i} cliName={info.name} onEdit={() => onEditAccount(i)} onUsage={() => onUsage(i)} onSaid={onSaid} />
          ))}
        </ul>
      ) : (
        <InstallHint cli={cli} onCheck={() => void load()} />
      )}
    </section>
  );
}

function InstallHint({ cli, onCheck }: { cli: CliId; onCheck: () => void }) {
  const info = CLI_INFO[cli];
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  return (
    <div className="flex flex-col gap-2.5 border-t bg-muted/30 px-4 py-3">
      <p className="text-sm text-muted-foreground">Install it in a terminal, then sign in here.</p>
      <div className="flex min-w-0 items-center gap-1 rounded-lg border bg-background py-1 ps-3 pe-1">
        <code className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere]">{info.install}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Copied" : `Copy the install command for ${info.name}`}
          onClick={() => {
            void navigator.clipboard?.writeText(info.install).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            });
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ExternalLink href={info.docs} className="text-sm">
          {info.name} setup guide
        </ExternalLink>
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            onCheck();
            setTimeout(() => setChecking(false), 600);
          }}
        >
          {checking ? <Spinner /> : <RefreshCwIcon />}
          Check again
        </Button>
      </div>
    </div>
  );
}

function AccountRow({
  instance,
  cliName,
  onEdit,
  onUsage,
  onSaid,
}: {
  instance: InstanceView;
  cliName: string;
  onEdit: () => void;
  onUsage: () => void;
  onSaid: (t: string) => void;
}) {
  const { load, signIn, cancelSignIn } = useAgents();
  const waiting = useAgents((s) => !!s.signingIn[instance.config.id]);
  const outcome = useAgents((s) => s.outcomes[instance.config.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { config } = instance;
  const builtIn = config.id === config.cli;
  const name = builtIn ? "Default account" : instance.readOnly ? "Your own setup" : config.name;
  const st = instanceStatus(instance);
  const statusId = `account-${config.id}-status`;
  const canSignIn = instance.installed && !instance.readOnly;

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
      onSaid(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function startSignIn() {
    setError("");
    onSaid(`Opening ${cliName}’s sign-in in your browser.`);
    const result = await signIn(config.id);
    if (result) onSaid(result.message);
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[0.9375rem] font-medium">{name}</span>
            {instance.selected ? (
              <Badge variant="secondary" size="lg">
                In use
              </Badge>
            ) : null}
          </div>
          <span id={statusId} className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <Dot tone={waiting ? "busy" : st.tone} />
            <span className="min-w-0 truncate">{waiting ? "Waiting for you to finish in your browser" : st.text}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {waiting ? (
            <>
              <Spinner className="size-4 text-muted-foreground" />
              <Button variant="outline" size="sm" onClick={() => void cancelSignIn(config.id)}>
                Cancel sign-in
              </Button>
            </>
          ) : canSignIn && instance.loggedIn !== true ? (
            <Button variant={instance.loggedIn === false ? "default" : "outline"} size="sm" disabled={busy} onClick={() => void startSignIn()} aria-describedby={statusId}>
              Sign in
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${name}, ${cliName}`} disabled={busy || waiting} />}>
              {busy ? <Spinner /> : <EllipsisIcon />}
            </MenuTrigger>
            <MenuPopup align="end">
              {!instance.selected ? (
                <MenuItem disabled={!instance.installed} onClick={() => void run(() => selectInstance(config.id), `${cliName} answers now, with ${name.toLowerCase() === "default account" ? "the default account" : name}.`)}>
                  Answer with this account
                </MenuItem>
              ) : null}
              {canSignIn && instance.loggedIn === true ? <MenuItem onClick={() => void startSignIn()}>Change account</MenuItem> : null}
              {canSignIn && instance.loggedIn === true && config.cli !== "gemini" ? (
                <MenuItem onClick={() => void run(() => signOutInstance(config.id), `Signed out of ${cliName}.`)}>Sign out</MenuItem>
              ) : null}
              {config.cli !== "gemini" ? (
                <MenuItem disabled={!instance.installed || instance.loggedIn !== true} onClick={onUsage}>
                  Usage limits
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => void run(async () => {}, "Status refreshed.")}>Refresh status</MenuItem>
              {!builtIn && !instance.readOnly ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={onEdit}>Edit…</MenuItem>
                  <MenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
                    Remove…
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {confirmRemove ? (
        <div role="group" aria-label={`Remove ${name}?`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-error-surface px-3 py-2">
          <p className="min-w-0 flex-[1_1_16rem] text-sm">Remove {name}? Its sign-in stays on this computer.</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" autoFocus onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => removeInstance(config.id), `${name} removed.`).then(() => setConfirmRemove(false))}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
      {outcome && outcome.status !== "signedIn" ? (
        <FieldMessage tone={outcome.status === "cancelled" ? "muted" : "warning"}>{outcome.message}</FieldMessage>
      ) : null}
      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      {instance.readOnly ? <p className={cn("text-sm text-muted-foreground")}>Uses {cliName}’s own folder on this computer.</p> : null}
    </li>
  );
}
