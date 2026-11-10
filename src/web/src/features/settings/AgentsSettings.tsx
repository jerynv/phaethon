/**
 * Settings › Coding agents: Claude Code, Codex and Gemini CLI (installed?
 * signed in? which account?), and for one space the answering CLI's model and
 * reasoning, its workspace folder, full access and folders shared between
 * spaces. Phaethon never handles a CLI's credentials: sign-in is always the
 * CLI's own, in the browser.
 */
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNav } from "@/app/nav";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { AccountDialog, UsageDialog, type AccountTarget } from "./agents/AccountDialog";
import { CLI_IDS, type InstanceView } from "./agents/api";
import { CliCard } from "./agents/CliCard";
import { Grants } from "./agents/Grants";
import { SpaceAgentSettings } from "./agents/SpaceAgentSettings";
import { useAgents } from "./agents/store";
import { cliOfBackend, SETTINGS_CHANGED_EVENT } from "./providers/api";
import { useAssistant } from "./providers/store";
import { Section, useLiveRegion } from "./providers/ui";

export function AgentsSettings({ spaceId }: { spaceId?: string }) {
  const agents = useAgents();
  const { settings, spaces, load: loadAssistant } = useAssistant();
  const navSpace = useNav((s) => s.spaceId);
  const [chosenSpace, setChosenSpace] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountTarget | null>(null);
  const [usage, setUsage] = useState<InstanceView | null>(null);
  const { say, region } = useLiveRegion();
  const { load } = agents;

  useEffect(() => {
    void load();
    void loadAssistant();
    const reread = () => {
      void load();
      void loadAssistant();
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, reread);
    window.addEventListener("focus", reread);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reread);
      window.removeEventListener("focus", reread);
    };
  }, [load, loadAssistant]);

  const space = spaceId ?? chosenSpace ?? navSpace;
  const spaceName = spaces.find((s) => s.id === space)?.name ?? space;
  const cli = settings ? cliOfBackend(settings.backend) : null;

  return (
    <div className="flex flex-col gap-8">
      {region}
      <Section title="On this computer" headingId="agents-clis">
        {agents.status === "error" && !agents.instances.length ? (
          <Alert variant="error">
            <AlertTitle>The coding agents couldn’t be checked</AlertTitle>
            <AlertDescription>{agents.error}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCcwIcon />
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : agents.status === "loading" && !agents.instances.length ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Checking coding agents">
            {CLI_IDS.map((c) => (
              <div key={c} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {CLI_IDS.map((c) => (
              <CliCard
                key={c}
                cli={c}
                status={agents.clis.find((s) => s.id === c)}
                instances={agents.instances.filter((i) => i.config.cli === c)}
                answering={cli === c}
                onAddAccount={(which) => setAccount({ mode: "add", cli: which })}
                onEditAccount={(instance) => setAccount({ mode: "edit", instance })}
                onUsage={setUsage}
                onSaid={say}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={spaceId ? `In ${spaceName}` : "In a space"}
        headingId="agents-space"
        action={
          spaceId || spaces.length < 2 ? null : (
            <Select value={space} onValueChange={(v) => setChosenSpace(String(v))}>
              <SelectTrigger size="sm" aria-label="Space" className="min-w-40">
                <SelectValue>{(v: string) => spaces.find((s) => s.id === v)?.name ?? v}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {spaces.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )
        }
      >
        <SpaceAgentSettings space={space} spaceName={spaceName} cli={cli} onSaid={say} />
      </Section>

      <Section title="Shared between spaces" description="Read-only access one space has to another’s files." headingId="agents-grants">
        <Grants space={space} spaces={spaces} onSaid={say} />
      </Section>

      <AccountDialog target={account} onClose={() => setAccount(null)} onSaid={say} />
      <UsageDialog instance={usage} onClose={() => setUsage(null)} />
    </div>
  );
}
