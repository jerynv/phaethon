# Architecture

Status: design draft for pre-alpha. Items marked **(to verify in spike)** are assumptions that must be proven before anything depends on them.

## Model: vaults and spaces

A **vault** belongs to one person. It is a plain folder on disk:

```
<vault>/
  MANUAL.md            # how this person wants the agent to work; read at the start of every session
  memory/              # durable notes the agent maintains (preferences, facts, history)
  skills/              # reusable procedures the agent can invoke
  spaces/
    school/            # one isolated compartment
      ...              # whatever files that space needs
    work/
      ...
```

A **space** is a compartment inside a vault. The agent runs inside exactly one space at a time and must not read or write anything in a sibling space. Vault-level `MANUAL.md`, `memory/` and `skills/` are shared context across that vault's spaces; per-space overrides live inside the space folder.

Multiple vaults on one machine (for example two family members sharing a computer) are fully separate: separate folders, separate agent configuration, separate secrets.

## Files are the database

There is no hidden database. Every piece of state the user cares about is a file in the vault, in a format a person can open in a text editor (Markdown, JSON, plain text). Consequences:

- Users can inspect, edit, diff, back up and delete anything with ordinary tools.
- Indexes or caches steward builds for speed are derived, disposable and rebuildable from the files.
- Any schema change must keep files readable by a human first and by the app second.

## Agent backends

Two backends, chosen per vault:

1. **The official `claude` CLI.** The user installs it and logs in themselves. steward spawns it as a child process and talks to it over its documented interface.
2. **Bring-your-own API key.** The key is stored in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux) and used to call the provider API directly.

### Auth rule for subscription tokens

steward **never reads, stores, copies or relays** the OAuth token the `claude` CLI holds for the user's subscription. It does not open the CLI's credential files, does not forward that token to any server (including a future steward relay), and does not offer "log in with your subscription" inside steward. The CLI owns its own login; steward only runs the CLI. A BYO API key is the only credential steward itself handles, and only through the keychain.

### The `claude` CLI backend as built

The Rust core (`src-tauri/src/agent.rs`) runs one child process per turn:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
  --tools Read,Grep,Glob --allowedTools Read,Grep,Glob \
  --permission-mode dontAsk --permission-prompts none \
  --restricted --strict-mcp-config --no-chrome [--resume <session-id>]
```

- **Working directory** is the space folder, `~/Steward/<vault>/spaces/<space>/`. The default vault `default` with spaces `school` and `work` is created on first run.
- **Prompt over stdin**, never argv: it cannot be parsed as a flag and does not show up in `ps`.
- **One conversation per space.** The session id from the CLI's output is saved to `<space>/.steward/session` and passed back with `--resume`. The file is user-editable and may sync, so anything that is not a plain UUID is ignored rather than passed to the CLI. A session the CLI no longer knows is cleared, and the next message starts fresh.
- **Read-only tools, no prompts.** `--tools` removes every tool except `Read`, `Grep` and `Glob`; `--allowedTools` lets those run; `dontAsk` plus `--permission-prompts none` deny anything else instead of waiting for an answer nobody can give (there is no permission UI yet). Write and command tools come with an in-app confirmation flow, not before. No `bypassPermissions`, ever.
- **`--restricted`** confines file tools to the working directory and ignores the user's own settings files, including their hooks; `--strict-mcp-config` with no config loads no MCP servers. The user's CLI setup should not leak into steward's agent.
- **Binary lookup:** `PATH`, then `~/.local/bin` (the installer's default, and not on `PATH` for an app launched from Finder). If missing, the UI says "Install Claude Code, then run `claude` once in a terminal to log in."
- **No zombies, no orphans.** The child leads its own process group. Cancel sends SIGTERM to the group, then SIGKILL after 1.5 s, and always reaps the child. Closing the window or quitting kills every running group; so does SIGTERM, SIGINT or SIGHUP to steward.
- Variables a parent Claude Code session sets (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, ...) are removed from the child's environment so the CLI does not think it is nested. Everything else, including a user-set `CLAUDE_CONFIG_DIR`, is inherited.
- The webview gets events over a Tauri channel (`text`, `tool`, `error`, `cancelled`, `end`) through two commands, `agent_send` and `agent_cancel`, both gated by the capability ACL.

Open questions: the CLI still auto-discovers `CLAUDE.md` files (including the user's global one), and user skills may still be invocable by slash command in a prompt. Decide whether steward should pass `--safe-mode` or `--setting-sources` once the vault's `MANUAL.md` is wired in.

### CLAUDE_CONFIG_DIR finding

Checked on 2026-10-09 with `claude` 2.1.296 on macOS, from a shell where the user is logged in:

```
$ CLAUDE_CONFIG_DIR=$(mktemp -d) claude -p "hi"
Not logged in · Please run /login
$ echo $?
1
```

- The same result with every variable from the parent Claude Code session removed, so it is not a nesting artefact.
- The empty directory was populated by that run (`.claude.json`, `backups/`, `projects/<cwd>/<session>.jsonl`, `sessions/`), and `~/.claude.json` was not modified. Config and session history follow `CLAUDE_CONFIG_DIR`.
- With steward's flags and `--output-format stream-json`, the init event reports `"apiKeySource":"none"` and the run ends with a `result` event `"is_error":true`, `"result":"Not logged in · Please run /login"`. steward maps that to "Claude Code is not logged in. Run `claude` once in a terminal to log in."

Conclusion: a per-vault `CLAUDE_CONFIG_DIR` does isolate the CLI's state, and that includes login: **each vault would need its own `claude` login.** steward therefore does not set it by default. It is an opt-in stub: `"isolateClaudeConfig": true` in `<vault>/.steward/settings.json` makes steward run the CLI with `CLAUDE_CONFIG_DIR=<app data dir>/claude-config/<vault>`, and the user logs in once with that variable set. The directory is outside the vault on purpose: the CLI may keep credentials in its config dir, and vaults sync. There is no UI for this setting yet.

## Isolation enforcement

Isolation is enforced by the host process, not by asking the model to behave.

| Boundary | Mechanism | Status |
| --- | --- | --- |
| Vault vs vault (CLI backend) | A per-vault `CLAUDE_CONFIG_DIR` so each vault gets its own CLI configuration, session history and settings | **partly verified** (see [CLAUDE_CONFIG_DIR finding](#claude_config_dir-finding)): login state is per config dir, so isolation works but costs a separate login per vault. Opt-in only, off by default. Still open: whether anything leaks through the default config location |
| Space vs space | The agent process is spawned with its working directory set to `spaces/<name>/` and `--restricted`, which confines the CLI's file tools to the working directory | **one positive check**: asked from `work` to read an absolute path in `school`, the agent did not return the file's contents (`tests/claude_cli.rs`, `work_cannot_read_school`). Not yet proven exhaustively (symlinks, Glob/Grep paths, vault-shared files are not reachable yet) |
| Secrets | Keychain entries namespaced `steward/<vault-id>/<space-id>/<name>`; one space cannot request another's entries | design |
| Secrets vs sync | Secrets live only in the OS keychain and are **never** written into the vault folder, so they never sync | design |
| Rust core as gatekeeper | All filesystem and process access from the UI goes through Tauri commands in the Rust core, which validate paths against the active vault and space | design |

## Sync

The vault is a folder, so sync is whatever moves folders:

- iCloud Drive, git, or Syncthing out of the box, with no steward server involved.
- Conflict handling relies on the files being plain text and mergeable; the app should surface conflicts, not hide them.
- **Later, optional:** a hosted relay for people who do not want to run any of the above. It is opt-in, never required, and the auth rule above still applies: it never carries subscription tokens, and keychain secrets never leave the device.

## Process layout

```
Tauri shell (Rust core, src-tauri/)
  ├── WebView: React UI (src/) — assistant-ui thread, shadcn/ui components
  ├── Vault service: reads/writes vault files, validates paths
  ├── Secrets service: OS keychain, namespaced vault/space
  └── Agent supervisor: spawns `claude` CLI per space (cwd + CLAUDE_CONFIG_DIR), or calls API with BYO key
```

Current state: the WebView and the agent supervisor exist. Spaces are still a stub list in the UI, backed by real folders on disk. Inside the desktop app each space talks to the `claude` CLI (`src/runtime/claude-adapter.ts`); in a plain browser (`pnpm dev`) there is no IPC, so the UI falls back to the echo adapter (`src/runtime/echo-adapter.ts`). Each space gets its own assistant-ui runtime instance, and leaving a space stops any reply still running there. Threads live in memory only: the CLI keeps the conversation, but the UI does not reload it yet.
