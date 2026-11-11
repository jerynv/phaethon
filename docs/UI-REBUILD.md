# UI rebuild (Nov 11, 2026)

Jeryn's direction for Phaethon's interface. This replaces every earlier UI plan; nothing from the previous interface is a reference.

## Direction

- **Flat, minimal, condensed.** Think modern SaaS: T3 Code, Linear, Vercel, Raycast. Dense but calm, hairline borders, small type, few colours, no decoration that doesn't carry information.
- **shadcn on Base UI** (`components.json`: base-mira, `@base-ui/react`, Tailwind v4) as the component base. Take components straight from [T3 Code](https://github.com/pingdotgg/t3code) (MIT: keep its notice in THIRD_PARTY_NOTICES.md) wherever they fit, or implement in the same spirit.
- **Typography is deliberate.** Choose a typeface and a type scale on purpose (sizes, weights, tracking, line heights, tabular numbers where numbers align) and use it consistently. Contrast tests and accessibility audits are not part of this work.
- **Icons chosen per occurrence.** Pick from any library (lucide, Tabler, Phosphor, Hugeicons, Simple Icons for brands, …) the icon that fits each place best. Consistent stroke and size within a surface matters more than a single library.
- **Loading is designed, not defaulted.** Skeletons that match the layout they stand in for, inline progress where work is in place, streaming that feels smooth. No generic full-screen spinners.
- **Errors and overflow are designed too.** Every error state says what happened and what to do, in place, sized to the surface (inline field error, row error, banner, toast), never a raw message dumped on screen. Every text that can grow (titles, file names, paths, model names, long words, code) has a decided behaviour: truncate with a tooltip, clamp, wrap, or scroll.
- **Model selection is per conversation**, like T3 Code: the composer carries the provider/model (and reasoning effort where the model has it) for that chat, remembered with the chat, defaulting to the last one used. Coding-agent backends (Claude Code, Codex, Gemini CLI) appear in the same picker.

## What's here to build on

Only plumbing survives in `src/web/src`; everything visual was removed on purpose.
- `lib/core.ts`: the transport to the Node core (`invoke(name, args)` and `Channel` streams over a MessagePort in Electron, WebSocket standalone).
- `features/*/api.ts`: typed wrappers around core commands; `features/*/lib/`: tested pure logic (chat timeline reducer, attachments, math delimiters, diffs, study citations, grade what-if, schedule, quiz scoring, provider and agent logic).
- `dev/mock-core.ts` and `dev/mocks/`: a fake core with realistic data for running the UI in a browser with `pnpm dev`, without Electron.
- `assets/providers/`: provider logos.
- The core's commands are registered with `commands({ … })` in `src/server/**/commands.ts`, `agent/turn.ts` and `agent/tutor.ts`; shared types are in `src/shared/`. Model choice is per space today (`space_model_get`/`space_model_set`, `agent_send`); per-conversation choice needs a core change, kept compatible with existing thread files.
- `src/server/agent/app-guide.ts` describes the app's screens to the agent; rewrite it to match the new UI.
- `e2e/core.ts` starts the real core with a scripted model (`PHAETHON_FAKE_PROVIDER`); the old specs were removed, so write new ones.

## Surfaces

Shell (sidebar with spaces and conversations, search, title bar), first-run setup, chat (timeline, markdown with KaTeX, mermaid and compiled LaTeX, composer with attachments and the model picker, tool approvals, access requests, lesson plan and question cards), study (decks, review, quizzes), grades, plan, courses (sign-in, import, access), file viewer, settings (providers, coding agents, spaces, appearance, about and updates).
