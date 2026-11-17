# CLAUDE.md: Phaethon

Read this first, then `docs/ARCHITECTURE.md` and `docs/ACCESSIBILITY.md`. Also check `git log`, since the state below may be out of date.

## What this is
Phaethon is Jeryn Vicari's open-source "life OS": an accessible, desktop-first AI agent workspace. It turns a pattern he already runs privately into something anyone can plug their own AI into. That private pattern is a repo with:
- a CLAUDE.md operating manual
- scripts as tools, plus hooks
- a daily digest
- skills
- PDF and video recipes

It's meant to be his biggest long-running project. MIT licensed, and nothing has been pushed (no remote yet).

## Decisions already made (don't relitigate)
- **Desktop-first.** Mobile comes later by serving the same HTML UI over Tailscale, not as a second app.
- **Stack:** Tauri 2 + React 19 + TypeScript + Vite, using pnpm. UI is shadcn/ui on Radix, plus `@assistant-ui/react` for chat, plus React Aria where Radix has gaps. Core is Rust in `src-tauri`.
  - Rejected: Flutter (heavy on the web, weak web accessibility), and any toolkit that draws its own UI (GPUI, Slint). Both lose on accessibility.
- **Open WebUI is rejected.** Its license clause 4 bans rebranding past 50 users, and its backend is Python.
- **LibreChat (MIT) is a reference only**, not forked: it's a Node + MongoDB server. If you copy a component from it, keep its MIT notice.
- **"Containerization" means compartmentalizing each person, not Docker.**
  - A **vault** is one person's folder: `MANUAL.md`, `memory/`, `skills/`, `spaces/`.
  - A **space** is an isolated compartment inside the vault (school, work, …).
  - Code enforces the walls: the working directory is scoped to the space, keychain secrets are namespaced by vault and space and never synced, and data is plain files.
- **Sync** works through iCloud, git or Syncthing. An optional hosted relay comes later, and it's the business model.
- **Accessibility for every kind of disability is a day-one constraint.** WCAG 2.2 AA is the floor, and disabled testers come in at alpha.
- **Subscription rule (Anthropic's terms, not a preference):** never read, store, proxy or relay a user's Claude Pro/Max OAuth credentials. Using a subscription is only OK when Phaethon spawns the official CLI that the user logged into themselves.

## State as of Oct 9, 2026 (HEAD d13c531)
- `d314c8e`: scaffold. A sidebar of spaces plus an assistant-ui thread; an echo adapter is the fallback outside Tauri.
- `beeafa8`: strict CSP and least-privilege capabilities.
  - Only `style-src` allows inline styles, because Radix ScrollArea injects a `<style>` tag.
  - `devCsp` is served by `vite.config.ts`, because Tauri's `devCsp` doesn't take effect on desktop.
- `d13c531`: the `claude` CLI is the backend, per space.
  - Code: `src-tauri/src/agent.rs`, `vault.rs`; `src/runtime/claude-adapter.ts`.
  - Flags: read-only tools, `--permission-mode dontAsk`, `--restricted`, `--strict-mcp-config`, and `--resume` per space. The session ID lives in `<space>/.phaethon/session`.
  - Cancel kills the process group.
  - Proven from Rust with the real CLI (`cargo test --test claude_cli -- --ignored`, which uses real prompts on Jeryn's account, so keep runs rare). Proven in the app only with a fake CLI (`PHAETHON_CLAUDE_BIN`).
- The vault lives at `~/Phaethon/default/spaces/{school,work}` (moved from `~/Steward` on first launch after the rename).
- `CLAUDE_CONFIG_DIR` per vault isolates the login too, so each vault needs its own login. It's opt-in via `<vault>/.phaethon/settings.json` `isolateClaudeConfig`.

## Known gaps
1. ~~Isolation leak~~ fixed in `8ce2c70` (`--safe-mode --disable-slash-commands`).
2. ~~Threads in memory only~~ fixed for every backend (`c2dec3d`: CLI turns recorded in `thread.json`, one CLI session per conversation).
3. ~~No permission UI~~ Phaethon's loop has an approval card for `write_file`. CLI backends stay read-only by design.
4. Cleanup of child processes after a hard crash is unproven.
5. The `.dmg` bundle needs Finder Automation permission; `--bundles app` works.

## DECIDED Oct 9: approved by Jeryn
Approved: **Phaethon owns the agent loop (pattern 1), and external agents become plug-ins (pattern 3).**
- **Provider layer in the Rust core:** Anthropic, OpenAI, OpenRouter and Ollama. Keys stay in the keychain, held by Rust, never in the webview.
- **Phaethon's own tool loop and tools:** space-scoped file read/write, a skills loader, PDF, search.
  - This makes isolation real, because nothing global is ever loaded.
- **External agents (Claude Code / Codex / Gemini CLI) become an optional backend,** via ACP or the existing CLI code. Today's CLI work becomes one backend among several.
- **Hosted credits later** (Phaethon-owned key, around $20/mo) as the business model.
- **The work:** the provider interface, the Anthropic provider, file tools and a permission UI.

## Oct 9 (later): Phaethon's own loop built (7555dd9 core, fab9c22 ui)
- Rust: `provider.rs` (interface), `anthropic.rs` (raw HTTP + SSE), `tools.rs`, `agent_loop.rs`, `thread.rs`, `secrets.rs` (keychain). UI: approval card, thread reload, Settings dialog.
- Proven: unit tests plus fake-server HTTP tests (`tests/anthropic_http.rs`, `tests/loop_http.rs`); UI flow in Obscura with mocked IPC; the real app mounts.
- NOT proven: a real Anthropic API call (no key on this machine), and clicking through the native window.
- `node_modules` had been copied with links dereferenced (duplicate React, broken types); rebuilt with `rm -rf node_modules && pnpm install --frozen-lockfile`. If `useState` of null or `any` types come back, check that first.

## Oct 10: UI rebuilt and audited (HEAD 8ad756e)
- Design system: `src/styles/tokens.css` (oklch only, everything a token, sizes follow `--ph-ui-scale`), own icons in `src/icons`, `scripts/check-design.mjs` runs in every build.
- `pnpm test` = build + every UI scenario in chrome-headless-shell (`scripts/ui-preview`, fake backend in `mock-ipc.js`). Add `--axe`, `--scale 2`, `--forced-colors`, `--sizes 640x480` for variants. 212+ scenarios, 0 axe violations at last run.
- Two audit rounds done (A-001…A-054, N-001…N-013), all fixed and verified in Chromium. Reading font setting (Atkinson / OpenDyslexic / Lexend / system).
- Grants between spaces: read-only, asked in chat, `<vault>/.phaethon/grants.json`.
- Not yet seen: the native window (needs Screen Recording for the terminal), a real Anthropic call (no key), a screen reader pass.

## Oct 10–11: built since (see `git log` for detail)
- **Course sites** (`src-tauri/src/lms/`): Canvas, Brightspace, Moodle, Blackboard. Sign-in in a popup window, session cookies + CSRF in the keychain, smart import into `<vault>/courses/`, OCR, grades. Courses belong to the vault; each space gets per-course, per-part access (`<vault>/.phaethon/course-access.json`), enforced in Rust.
- **Study** (`src-tauri/src/study/`): decks, quizzes, confidence-based review, plan. Practice content is grounded: a per-course scope map (topics, notation, each exam's scope, all with quotes checked against the files) and a gate that drops any question not taught in its cited passage or outside the exam.
- **Providers:** Anthropic plus OpenAI-compatible ones (OpenAI, OpenRouter, Groq, …, Ollama, LM Studio, own server); model per space as `provider:model`. **CLI backends:** Claude Code, Codex, Gemini CLI (Gemini refuses Jeryn's free account).
- **Chat output:** KaTeX math, mermaid, LaTeX documents compiled under macOS `sandbox-exec` (TeX Live 2026 no longer blocks file reads by itself), in-app file viewer, `phaethon-study` cards that generate a quiz.
- Real-world proof so far: IU Canvas sign-in and import, a real Claude CLI quiz and C241 practice test. Still unseen: the native window clicked through, a screen reader pass.

## Rules for working here
- **Never kill processes by name pattern** (`pkill -f vite` took down Jeryn's VS Code and Chrome on Oct 9). Kill only PIDs you started, then confirm the port is free.
- **Commit style** is lowercase conventional (`feat: …`, `chore: …`). **No AI attribution anywhere** in git.
- **Verify behaviour, not builds:** run the flow and say exactly what you did and didn't exercise. For headless browser checks use `~/.local/bin/obscura`, never Chrome.
- **Rust** is in `~/.cargo/bin`.
- **Jeryn's schedule:** C241 Test 1 is Thu Oct 15 or Fri Oct 16 (by discussion section), through HW 6, no graphs or combinatorics. M301 Exam 1 was Sep 23; the next M301 exam date isn't confirmed on the course site, so don't state one. If a Phaethon session runs long, remind him.
