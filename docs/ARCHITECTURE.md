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

## Isolation enforcement

Isolation is enforced by the host process, not by asking the model to behave.

| Boundary | Mechanism | Status |
| --- | --- | --- |
| Vault vs vault (CLI backend) | A per-vault `CLAUDE_CONFIG_DIR` so each vault gets its own CLI configuration, session history and settings | **to verify in spike**: confirm which CLI state honours `CLAUDE_CONFIG_DIR`, whether login state is per-directory, and that nothing leaks through the default config location |
| Space vs space | The agent process is spawned with its working directory set to `spaces/<name>/`, plus a file-access allowlist limited to that space and the vault's shared files | to verify in spike: confirm the CLI's file tools cannot escape the cwd and allowlist |
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

Current state: only the WebView exists, with stub spaces and an echo model adapter (`src/runtime/echo-adapter.ts`). Each space gets its own assistant-ui runtime instance, so threads already do not cross spaces in the UI.
