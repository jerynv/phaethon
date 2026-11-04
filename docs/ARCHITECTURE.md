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
- Indexes or caches Phaethon builds for speed are derived, disposable and rebuildable from the files.
- Any schema change must keep files readable by a human first and by the app second.

## Agent backends

Two backends, chosen per vault (`"backend"` in `<vault>/.phaethon/settings.json`, set from Settings):

1. **Phaethon's own loop (default).** The Rust core calls the provider API with the user's key and runs Phaethon's own tools (`agent_loop.rs`, `anthropic.rs`, `tools.rs`). The key lives in the OS keychain under `Phaethon` / `<vault>/provider/<name>`; the webview can set or clear it but no command returns it. Tools are `list_files`, `read_file`, `search_files` and `write_file`, all confined to the space (no absolute paths, no `..`, no symlink escape, `.phaethon/` hidden). `write_file` waits for the user to allow it in an approval card. Attachments are saved into the space under `attachments/<date>/` and sent as image or document blocks. Reading another space needs a read-only grant (`grants.rs`): the agent asks with `request_access`, the user answers once, always or deny in the conversation, "always" grants live in `<vault>/.phaethon/grants.json`, and the read tools then accept `@<space>/<path>` inside the granted folder only. A deny holds for the rest of the conversation, including after an edit or regenerate cuts the reply that recorded it (the cut carries it forward as a hidden `deniedEarlier` record). The system prompt, which lists the space's standing grants, is rebuilt for every model call, so a grant removed mid-reply drops out of it at once. Nothing global is loaded: the model sees Phaethon's prompt, the vault's `MANUAL.md` and the space. The current conversation is `<space>/.phaethon/thread.json`, append-only so returned thinking blocks stay valid. New conversation moves it (by rename, never rewritten) to `<space>/.phaethon/threads/<id>.json`, and reopening one moves it back; `thread_delete` removes a saved one for good (or, with `current`, empties the current one and the CLI session). All three are refused while a reply runs in that space, and an id that isn't an archive id is never turned into a path. `claude_cli_status` says only whether the `claude` program is installed and where; it never looks at the login. Anthropic (`anthropic.rs`: `claude-opus-5-5`, effort `medium`, `fallbacks: "default"`) by default; OpenAI, OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Ollama, LM Studio and a server of one's own through `openai.rs` (Chat Completions, converted at the boundary; thread.json stays in the Messages API shape). The provider is `"provider"` in settings.json, a model is `provider:model` (a plain id is Anthropic's) there and in space.json, and `providers.rs` keeps each key to its own provider: fixed addresses for the services, no redirects, an own server's key bound to the origin it was saved for, no key for local servers.
2. **The official `claude` CLI.** The user installs it and logs in themselves. Phaethon spawns it as a child process and talks to it over its documented interface.

### Auth rule for subscription tokens

Phaethon **never reads, stores, copies or relays** the OAuth token the `claude` CLI holds for the user's subscription. It does not open the CLI's credential files, does not forward that token to any server (including a future Phaethon relay), and does not offer "log in with your subscription" inside Phaethon. The CLI owns its own login; Phaethon only runs the CLI. A BYO API key is the only credential Phaethon itself handles, and only through the keychain.

### The `claude` CLI backend as built

The Rust core (`src-tauri/src/agent.rs`) runs one child process per turn:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
  --tools Read,Grep,Glob --allowedTools Read,Grep,Glob \
  --permission-mode dontAsk --permission-prompts none \
  --restricted --strict-mcp-config --no-chrome \
  --safe-mode --disable-slash-commands [--resume <session-id>]
```

- **Working directory** is the space folder, `~/Phaethon/<vault>/spaces/<space>/`. The default vault `default` with spaces `school` and `work` is created on first run.
- **Prompt over stdin**, never argv: it cannot be parsed as a flag and does not show up in `ps`.
- **A session per conversation.** Each turn is recorded in the same `thread.json` as Phaethon's own loop (the question with its files, the reply's text, a stopped record), so conversations are listed, searched, reopened, edited and cleared alike, and either backend can carry one on. The current conversation's CLI session id is in `<space>/.phaethon/session` and passed back with `--resume`; an archived conversation keeps its own as `threads/<id>.session`, which moves back when it is reopened. The file is user-editable and may sync, so anything that is not a plain UUID is ignored rather than passed to the CLI. A session the CLI no longer knows is cleared and the turn runs again in a fresh one; a fresh session on a conversation that already has messages (from Phaethon's loop, an edit, or a lost session) is given them first as plain text. New conversation starts a fresh session.
- **Read-only tools, no prompts.** `--tools` removes every tool except `Read`, `Grep` and `Glob`; `--allowedTools` lets those run; `dontAsk` plus `--permission-prompts none` deny anything else instead of waiting for an answer nobody can give (there is no permission UI yet). Write and command tools come with an in-app confirmation flow, not before. No `bypassPermissions`, ever.
- **`--restricted`** confines file tools to the working directory and ignores the user's own settings files, including their hooks; `--strict-mcp-config` with no config loads no MCP servers. The user's CLI setup should not leak into Phaethon's agent.
- **`--safe-mode`** turns off CLAUDE.md auto-discovery, plugins, hooks and custom agents while keeping the user's login; **`--disable-slash-commands`** removes every skill, built-in ones included. (`--bare` would refuse OAuth.) Checked with CLI 2.1.296: without `--safe-mode` the user's global `CLAUDE.md` reached the agent; `global_claude_md_does_not_leak` in `tests/claude_cli.rs` guards it.
- **Binary lookup:** `PATH`, then `~/.local/bin` (the installer's default, and not on `PATH` for an app launched from Finder). If missing, the UI says "Install Claude Code, then run `claude` once in a terminal to log in."
- **No zombies, no orphans.** The child leads its own process group. Cancel sends SIGTERM to the group, then SIGKILL after 1.5 s, and always reaps the child. Closing the window or quitting kills every running group; so does SIGTERM, SIGINT or SIGHUP to Phaethon.
- Variables a parent Claude Code session sets (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, ...) are removed from the child's environment so the CLI does not think it is nested. Everything else, including a user-set `CLAUDE_CONFIG_DIR`, is inherited.
- The webview gets events over a Tauri channel (`text`, `tool`, `approval`, `approvalDone`, `accessRequest`, `accessRequestDone`, `record`, `error`, `cancelled`, `end`) through `agent_send` and `agent_cancel`, gated by the capability ACL. `record` events are also saved in the thread as `phaethon_record` blocks (approval and access answers, reads in another space, stopped replies) and stripped from every request to the provider.

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
- With Phaethon's flags and `--output-format stream-json`, the init event reports `"apiKeySource":"none"` and the run ends with a `result` event `"is_error":true`, `"result":"Not logged in · Please run /login"`. Phaethon maps that to "Claude Code is not logged in. Run `claude` once in a terminal to log in."

Conclusion: a per-vault `CLAUDE_CONFIG_DIR` does isolate the CLI's state, and that includes login: **each vault would need its own `claude` login.** Phaethon therefore does not set it by default. It is an opt-in stub: `"isolateClaudeConfig": true` in `<vault>/.phaethon/settings.json` makes Phaethon run the CLI with `CLAUDE_CONFIG_DIR=<app data dir>/claude-config/<vault>`, and the user logs in once with that variable set. The directory is outside the vault on purpose: the CLI may keep credentials in its config dir, and vaults sync. There is no UI for this setting yet.

## Isolation enforcement

Isolation is enforced by the host process, not by asking the model to behave.

| Boundary | Mechanism | Status |
| --- | --- | --- |
| Vault vs vault (CLI backend) | A per-vault `CLAUDE_CONFIG_DIR` so each vault gets its own CLI configuration, session history and settings | **partly verified** (see [CLAUDE_CONFIG_DIR finding](#claude_config_dir-finding)): login state is per config dir, so isolation works but costs a separate login per vault. Opt-in only, off by default. Still open: whether anything leaks through the default config location |
| Space vs space (Phaethon's loop) | Tools resolve paths against the space root (no absolute, `..`, symlink escape or `.phaethon/`); another space is reachable only as `@space/path` inside a read-only grant the user approved; writes never cross | unit and fake-server tests in `tools.rs`, `grants.rs`, `agent_loop.rs`, `tests/grants_http.rs` |
| Space vs space (CLI) | The agent process is spawned with its working directory set to `spaces/<name>/` and `--restricted`, which confines the CLI's file tools to the working directory | **one positive check**: asked from `work` to read an absolute path in `school`, the agent did not return the file's contents (`tests/claude_cli.rs`, `work_cannot_read_school`). Not yet proven exhaustively (symlinks, Glob/Grep paths, vault-shared files are not reachable yet) |
| Secrets | Keychain entries namespaced `Phaethon/<vault-id>/<space-id>/<name>`; one space cannot request another's entries | design |
| Secrets vs sync | Secrets live only in the OS keychain and are **never** written into the vault folder, so they never sync | design |
| Rust core as gatekeeper | All filesystem and process access from the UI goes through Tauri commands in the Rust core, which validate paths against the active vault and space | design |

## Sync

The vault is a folder, so sync is whatever moves folders:

- iCloud Drive, git, or Syncthing out of the box, with no Phaethon server involved.
- Conflict handling relies on the files being plain text and mergeable; the app should surface conflicts, not hide them.
- **Later, optional:** a hosted relay for people who do not want to run any of the above. It is opt-in, never required, and the auth rule above still applies: it never carries subscription tokens, and keychain secrets never leave the device.

## Process layout

```
Tauri shell (Rust core, src-tauri/)
  ├── WebView: React UI (src/) — assistant-ui thread, Vic UI components
  ├── Vault service: reads/writes vault files, validates paths
  ├── Secrets service: OS keychain, namespaced vault/space
  └── Agent supervisor: spawns `claude` CLI per space (cwd + CLAUDE_CONFIG_DIR), or calls API with BYO key
```

Current state: the WebView and the agent supervisor exist. Spaces are the valid folders under `<vault>/spaces/` (`spaces.rs`), with name, description and hue in `<space>/.phaethon/space.json` (School and Work default to the Sky and Clay accent presets; a saved hue always wins); they can be created and edited, not deleted, and renaming never changes the folder. Inside the desktop app each space talks to the vault's backend (`src/runtime/agent-adapter.ts`); in a plain browser (`pnpm dev`) there is no IPC, so the UI falls back to the echo adapter (`src/runtime/echo-adapter.ts`). Each space gets its own assistant-ui runtime instance, and leaving a space stops any reply still running there. The saved thread is reloaded on start and on space switch, with either backend.

## November 2026 stack review and UI migration

Keep the current hybrid: Rust owns native operations and enforcement; React and TypeScript own the interface. Rust is justified for the OS keychain, scoped filesystem access, process-group supervision, platform OCR and the Tauri host. Moving the existing backend would add migration and packaging work without improving the Vic UI integration. The substantial LMS and study modules are mostly HTTP/JSON/business logic: their existence in Rust is not, by itself, a reason to build every future feature there.

The costs to address separately are the large command-registration module, manually mirrored IPC types, provider messages coupled to one API shape, and unexercised platform-specific paths. Generated IPC types and domain-sized command modules would improve this architecture without changing languages. The accompanying audit fixes reject dangling symlinks and aliases into protected state, refuse credential-bearing redirects, require an explicit study answer-verification verdict, and preserve cancellation while a CLI blocks on stdin or closes stdout before exiting.

The shared controls now consume Vic UI. Phaethon contributes native Input, TextareaControl, NativeSelect, Radio, Disclosure and Skeleton exports to that library, plus the mixed checkbox state. The bundled archive in `vendor/` records its source commit and excludes unrelated pending library edits. Appearance synchronizes Vic’s `data-mode` with the existing theme, reading font, contrast, motion, target-size and text-scale settings.

Vic UI now renders the shared dialog, tooltip, menu, popover, heading, action and scrolling surfaces. Its own overlays use the same exported components as Phaethon's adapters. Radix remains the behavioral layer for compound dialogs, tooltips, menus, custom sliders and swatch radios where Phaethon depends on cancellation hooks, focus restoration or its keyboard model; those controllers no longer provide a competing visible frame. Assistant-ui still owns the composer and chat runtime, and the app owns domain-specific quiz, LMS and approval behavior. Native file input and the Markdown renderer’s generic input fallback remain native by design.

`pnpm test` exercises the UI without generating images. The scenario runner also accepts `--shard 1/4` through `--shard 4/4` for parallel coverage; `--axe` returns a failing exit status on violations or audit errors. Screenshots remain opt-in by omitting `--no-screenshots` when invoking the runner directly.

Chat layout also uses two patterns inspected in T3 Code at `7f6f47b`: a single timestamp/action row under user messages, and a composer without an exterior shadow in dark mode. These are independently applied layout patterns; no T3 component implementation is copied.

The shell follows T3’s conventional sidebar structure: a flush main canvas, a divided sidebar with compact space rows, and aligned navigation and conversation headings. Settings uses a bounded dialog with a left navigation column and independently scrolling content. Its footer trigger aligns the actual Vic button face to the left. Reply actions share a compact row, and image attachments use proportional previews. The application’s former custom SVG set has been removed in favor of `lucide-react@0.564.0`, the version used by the inspected T3 source. Static icon imports retain application names and saved line-weight preferences. References: T3’s `AppSidebarLayout.tsx`, `Sidebar.tsx`, `ui/sidebar.tsx`, and `media/AttachmentImage.tsx`; T3 is MIT licensed and Lucide is ISC licensed.

The active space now exposes Chat, Study, Grades and Plan alongside its six newest conversations. Older history opens through the same Conversations controller; Search, New and keyboard shortcuts reuse its guarded actions. A single breadcrumb in the title bar names the space and current conversation or view. With the sidebar hidden, a compact row holds the view and conversation controls. The controller remains mounted and portals its controls into the visible host, so navigation does not create a second thread lifecycle. Selecting the current conversation from another view returns to Chat, preserves the draft and focuses the composer without reopening the saved thread. Current and older conversation selections, including the full history menu and both New controls, dismiss the narrow sidebar before composer focus.

Study, Grades and Plan share a small `WorkspacePage` layout component. Study prioritizes due practice, Plan puts upcoming deadlines before exam entry, and empty Chat offers working Study and Plan destinations. These choices follow stable global navigation and explicit practice entry points documented by Canvas and Quizlet, while T3’s `WorkspaceBreadcrumb`, `SidebarThreadRow`, `SidebarThreadHeader` and `ComposerSurface` supplied the coding-workspace reference. This pass retains the existing education behavior rather than adding another scheduling or content-generation system.

The owner rejected the first installed visual pass despite passing interaction checks and favorable review scores. Those scores did not establish visual acceptance. The next personal revision uses one header, section and compact empty-state system across Chat, Study, Grades, Plan and Settings. Education pages have their own bounded measure so a saved Wide reading preference affects chat without stretching every screen. Raised panels use Vic UI's `surface-lifted`; `bg-elevated` is darker than the canvas's surrounding controls in the dark palette and does not lift a panel. The composer has a quiet rim and inner highlight rather than a bright field outline. T3's 46rem lane is ported as 736px plus shared gutters because Phaethon's root font size follows its text preference. All changes preserve the saved font, hue, motion and focus preferences.

The revised Settings frame is 880 by 580 pixels before viewport limits, with its size independent of text scaling. Descriptions keep their 24em minimum where space permits and actions wrap below them. Closing overlays immediately release pointer events while their fade finishes; delayed wizard-heading focus was replaced with synchronous layout focus so it cannot swallow a checkbox keystroke. The final local build passed 789 Chromium checkpoints and 33 JavaScript unit tests. Targeted runs covered wizard validation, immediate Settings reopening, denied course access and loading stability in both themes and at desktop and narrow sizes. The matching macOS bundle was installed locally; no changes from this revision were pushed. A full accessibility pass remains deferred at the owner's request; optional sample audits reported desktop label/name mismatches.

The audit also identified work beyond this pass: bounded provider header/body waits, collision-resistant LMS connection IDs with migration of saved connections, Windows descendant-process cleanup, and platform-specific OCR/LaTeX and release test coverage. The filesystem resolver still uses check-then-open calls, so preventing concurrent symlink replacement requires a separate descriptor-based access change.
