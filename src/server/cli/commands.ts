import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../env.ts";
import { onStart } from "../lifecycle.ts";
import { log } from "../log.ts";
import { cancel, whileIdle } from "../core/runs.ts";
import { isValidSpaceId, spaceDir, spacesRoot } from "../core/vault.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { readSettings } from "../settings/settings.ts";
import { CLI, CLI_IDS, cliName, cliOfBackend, isCliId, loginCommand, type CliId } from "./cli.ts";
import { claudeHome, importConversations, importOnce, offered } from "./import.ts";
import * as instances from "./instances.ts";
import { listModels } from "./models.ts";
import { commonBinDirs, findBinary, findOnPath, isExecutable } from "./process.ts";
import { claudeSignIn, instanceRunKey, runKey, signIn } from "./signin.ts";

/**
 * The CLI backends' commands (cli.md §5): status, sign-in and sign-out,
 * connections, model catalogs and bringing in earlier Claude Code
 * conversations. Turns themselves go through the agent worker's
 * `agent_send`, which calls `runCliTurn`.
 */

export type CliStatus = { installed: boolean; path?: string };
export type CliInfo = { id: string; name: string; installed: boolean; loggedIn: boolean | null; loginCommand: string; supported: boolean; ownHome: boolean };

/** Whether a found path is an executable file; never runs it. No `path` key when it isn't. */
export function statusOf(found: string | null): CliStatus {
  return found && isExecutable(found) ? { installed: true, path: found } : { installed: false };
}

export async function clisInfo(): Promise<CliInfo[]> {
  const out: CliInfo[] = [];
  for (const cli of CLI_IDS) {
    const dir = instances.configDirFor(cli);
    const found = instances.binary(cli, dir);
    const bin = found && isExecutable(found) ? found : null;
    let loggedIn: boolean | null = null;
    if (bin && cli === "codex") loggedIn = await instances.codexLoggedIn(bin, dir);
    else if (bin && cli === "claude") loggedIn = (await instances.account(cli, dir)).loggedIn;
    out.push({ id: cli, name: cliName(cli), installed: bin !== null, loggedIn, loginCommand: loginCommand(cli, dir), supported: true, ownHome: CLI[cli].ownHome });
  }
  const home = homeDir();
  const opencode = findOnPath("opencode", [...commonBinDirs(), ...(home ? [path.join(home, ".opencode", "bin")] : [])]);
  out.push({ id: "opencode", name: "OpenCode", installed: opencode !== null, loggedIn: null, loginCommand: "opencode auth login", supported: false, ownHome: false });
  return out;
}

function cliArg(value: unknown, message: string): CliId {
  if (!isCliId(value)) throw new Refusal(message);
  return value;
}

/** The Claude Code home transcripts are read from: the selected connection's, else the person's. */
function importHome(): string | null {
  return claudeHome(instances.configDirFor("claude"));
}

commands({
  claude_cli_status: () => statusOf(findBinary("claude")),

  agent_clis_status: () => clisInfo(),

  agent_cli_sign_in: async ({ cli }: { cli: unknown }) => {
    if (cli !== "codex" && cli !== "gemini") throw new Refusal("Phaethon signs in only to Codex and Gemini CLI.");
    const home = instances.configDirFor(cli);
    if (!home) throw new Refusal(`Phaethon couldn’t find a folder for ${cliName(cli)}’s own setup.`);
    return signIn(cli, home);
  },

  agent_cli_sign_in_cancel: ({ cli }: { cli: unknown }) => (isCliId(cli) ? cancel(runKey(cli)) : false),

  agent_instances_list: () => instances.views(),

  agent_instance_save: ({ instance }: { instance: unknown }) => instances.save(instance),

  agent_instance_select: ({ id }: { id: unknown }) => {
    instances.select(String(id));
    return null;
  },

  agent_instance_sign_in: async ({ id }: { id: unknown }) => {
    const instance = instances.find(String(id));
    const home = instances.requireHome(instance);
    const cli = instances.cliOf(instance.cli);
    if (cli === "claude") return claudeSignIn(home, instance.id);
    if (!home) throw new Refusal("Assistant home is unavailable.");
    return signIn(cli, home);
  },

  agent_instance_sign_in_cancel: ({ id }: { id: unknown }) => {
    const instance = instances.list().find((i) => i.id === String(id));
    if (!instance || !isCliId(instance.cli)) return false;
    return instance.cli === "claude" ? cancel(instanceRunKey(instance.id)) : cancel(runKey(instance.cli));
  },

  agent_instance_remove: ({ id }: { id: unknown }) => {
    instances.remove(String(id));
    return null;
  },

  agent_instance_sign_out: async ({ id }: { id: unknown }) => {
    const instance = instances.find(String(id));
    await instances.signOut(instances.cliOf(instance.cli), instances.requireHome(instance));
    return null;
  },

  agent_instance_usage: async ({ id }: { id: unknown }) => {
    const instance = instances.find(String(id));
    return instances.usage(instances.cliOf(instance.cli), instances.requireHome(instance));
  },

  agent_cli_models: ({ cli }: { cli: unknown }) => {
    const id = cliArg(cli, "Phaethon doesn’t know that assistant.");
    return listModels(id, instances.configDirFor(id));
  },

  /** Browse a connection's models without selecting it. */
  agent_instance_models: async ({ id }: { id: unknown }) => {
    const instance = instances.find(String(id));
    return listModels(instances.cliOf(instance.cli), instances.requireHome(instance));
  },

  cli_import_offered: ({ space }: { space: unknown }) => {
    spaceDir(space);
    return offered(space as string, importHome(), cliOfBackend(readSettings().backend) === "claude");
  },

  cli_import_run: async ({ space }: { space: unknown }) => {
    spaceDir(space);
    const home = importHome();
    if (!home) return [];
    return whileIdle(space as string, () => {
      try {
        return importConversations(space as string, home);
      } catch (e) {
        throw new Refusal(`Earlier Claude Code conversations couldn’t be brought in: ${(e as Error).message}`);
      }
    });
  },
});

/** Once per launch, in the background: each space looks once for earlier Claude Code conversations. */
function importAtLaunch(): void {
  const home = importHome();
  if (!home) return;
  let ids: string[];
  try {
    ids = fs.readdirSync(spacesRoot()).filter(isValidSpaceId);
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      spaceDir(id);
    } catch {
      continue;
    }
    whileIdle(id, () => importOnce(id, home))
      .then((titles) => {
        if (titles?.length) log.info("brought in earlier Claude Code conversations", { space: id, count: titles.length });
      })
      .catch((e) => {
        // A busy space is left to the menu; anything else is only logged.
        log.debug("earlier Claude Code conversations not brought in", { space: id, error: (e as Error).message });
      });
  }
}

onStart("bring in earlier Claude Code conversations", () => {
  setImmediate(importAtLaunch);
});
