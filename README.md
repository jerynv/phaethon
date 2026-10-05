# steward

An open-source, accessible, desktop-first life OS: a workspace where an AI agent helps you run the parts of your life you choose to give it.

**Status: pre-alpha.** The shell renders and the chat surface works against a local echo stub. No model is wired up yet, nothing reads or writes a vault yet, and nothing here is ready for real data.

## What it is

- **Vaults.** Each person has a vault: a plain folder of files (`MANUAL.md`, `memory/`, `skills/`, `spaces/<name>/`). The files are the database. You can read, edit, back up and sync them with tools you already use.
- **Spaces.** Isolated compartments inside a vault (for example `school`, `work`). An agent working in one space cannot see another.
- **Bring your own agent backend.** Either the official `claude` CLI that you logged into yourself, or your own API key stored in the OS keychain. steward never reads, stores or relays a subscription OAuth token.
- **Accessible from day one.** WCAG 2.2 AA is the floor, across blind and low-vision, motor and switch, Deaf and hard-of-hearing, cognitive, and speech disabilities. See [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

Design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

- [Tauri 2](https://tauri.app) with a Rust core (`src-tauri/`)
- React 19 + TypeScript + Vite, managed with pnpm
- [shadcn/ui](https://ui.shadcn.com) on Radix primitives, Tailwind CSS v4
- [assistant-ui](https://github.com/assistant-ui/assistant-ui) (`@assistant-ui/react`) for the chat surface
- React Aria where Radix lacks a component

[LibreChat](https://github.com/LibreChat-AI/LibreChat) (MIT) is used as a design reference only. No code is vendored from it; if any is copied later, its MIT notice goes with it.

## Running it

Prerequisites: Node 20+, pnpm, a Rust toolchain via [rustup](https://rustup.rs), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (Xcode Command Line Tools on macOS).

```sh
pnpm install
pnpm tauri dev          # desktop app with hot reload
pnpm dev                # frontend only, in a browser at http://localhost:1420
pnpm build              # typecheck + production frontend build
pnpm tauri build        # release bundle (.app / .dmg / .msi / .AppImage)
```

## License

[MIT](LICENSE) © Jeryn Vicari
