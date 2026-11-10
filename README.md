# Phaethon

An open-source, accessible, desktop-first life OS: a workspace where an AI agent helps you run the parts of your life you choose to give it.

**Status: pre-alpha.** Each space chats through Phaethon's own agent with a provider you choose (Anthropic, OpenAI, OpenRouter, Groq, local models through Ollama or LM Studio, and more; keys stay in the system keychain), or through a coding agent you signed in to yourself (Claude Code, Codex or Gemini CLI). Either way the agent sees only that space's folder under `~/Phaethon/default/spaces/`, and Phaethon's agent asks before changing any file. Nothing here is ready for real data.

## What it is

- **Vaults.** Each person has a vault: a plain folder of files (`MANUAL.md`, `memory/`, `skills/`, `spaces/<name>/`). The files are the database. You can read, edit, back up and sync them with tools you already use.
- **Spaces.** Isolated compartments inside a vault (for example `school`, `work`). An agent working in one space cannot see another.
- **Bring your own agent backend.** Either the official `claude` CLI that you logged into yourself, or your own API key stored in the OS keychain. Phaethon never reads, stores or relays a subscription OAuth token.
- **Accessible from day one.** WCAG 2.2 AA is the floor, across blind and low-vision, motor and switch, Deaf and hard-of-hearing, cognitive, and speech disabilities. See [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

## Stack

Everything is TypeScript:

- [Electron](https://www.electronjs.org) shell (`src/desktop/`): windows, native dialogs, course-site sign-in windows, the updater. The UI is served from `app://phaethon` under a strict CSP.
- A Node core (`src/server/`) running as an Electron utility process: the vault, spaces, conversations, providers and Phaethon's agent loop, the coding-agent backends, course import, study tools. The renderer reaches it over a MessagePort; no network port is opened.
- React 19 + Vite UI (`src/web/`), [shadcn/ui](https://ui.shadcn.com) in its Base UI style on [`@base-ui/react`](https://base-ui.com), Tailwind CSS v4, lucide icons. Several primitives and patterns are adapted from [T3 Code](https://github.com/pingdotgg/t3code) (MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- The agent's teaching method (premises, justified steps, checks, lesson plans and graded questions) reimplements ideas from [LearnHarness](https://github.com/amosblomqvist/learnharness); no code or prompt text is copied from it.

Design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TYPESCRIPT-REWRITE.md](docs/TYPESCRIPT-REWRITE.md).

## Download

Installers for macOS (Apple silicon and Intel `.dmg`), Windows (`-setup.exe`) and Linux (`.AppImage`, `.deb`) are on the [latest release](https://github.com/jerynv/phaethon/releases/latest). Once installed, Phaethon checks for updates itself (Settings › About). Versions before 0.2 were built with Tauri and can't update themselves to this one: install it once by hand.

The macOS build isn't notarized yet, so the first open is blocked: open it once, then choose **Open Anyway** in System Settings › Privacy & Security.

## Running it

Prerequisites: Node 22.12+ and pnpm. For a coding-agent backend, install that CLI and sign in to it in a terminal.

```sh
pnpm install
pnpm dev            # desktop app with hot reload
pnpm test           # core and UI unit tests (no network, no real keychain)
pnpm test:ui        # build, then end-to-end UI tests against the real core with a scripted model
pnpm dist           # installer for this machine (release/)
node scripts/capture.mjs shot.png   # screenshot of the real app, headless
```

`node scripts/eval/reasoning.mjs <promptA.txt> <promptB.txt>` grades how two system prompts explain things, blind, through your own Claude Code login (a few short calls; never run in CI).

## License

[MIT](LICENSE) © Jeryn Vicari
