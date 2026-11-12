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

---

# Design spec

Written after studying T3 Code's web app (`apps/web`, commit d2c2595, Nov 11 2026). What we took from it and what we changed is noted per section. Everything below is the contract the code follows; `src/web/src/index.css` holds the tokens and `src/web/src/components/ui/` the primitives.

## What T3 Code does that we follow

- **Base UI primitives wrapped in thin shadcn-style files**, one per component, `data-slot` on every part, variants with `cva`, `cn()` = `tailwind-merge` extended with the extra font sizes. Copied (trimmed of T3-only hooks) into `components/ui/`: button, tooltip, menu, popover, dialog, select, switch, checkbox, input, textarea, kbd, badge, skeleton, spinner, empty, alert, scroll-area, separator, collapsible, toggle-group, middle-truncate, group. Toasts are a smaller rewrite on Base UI's Toast.
- **Compact geometry tokens** (`--control-radius`, row insets) so sidebar, menus and composer controls line up.
- **Sidebar** = flat list on a slightly tinted panel, 28 px rows, the selected row lifted one step, actions revealed on hover, relative time in the row's trailing slot with tabular numbers. Built from the parts in `components/ui/sidebar.tsx` (after T3 Code and shadcn/ui): provider, offcanvas panel, rail, groups, menu rows with a badge and hover actions laid over it (the badge keeps its width, so titles never reflow). A status gutter left of each conversation shows one mark: working (pulsing dot), new reply while you were elsewhere (dot), or pinned (Phosphor `PushPinSimple`, filled). Conversations rename in place from their menu, pin to the top of their space and delete after a confirm; a collapsed space shows its count and the new-reply dot.
- **Composer** = a raised card with one hairline outline; the controls row under the text sits inside the card: model picker (provider logo + model name + chevron), effort, then actions on the right. The model picker is a popover: provider rail on the left, search on top, model rows (logo · name · check), effort column on the right for models that have it.
- **Timeline** = user turns in a muted bubble aligned right, assistant turns as bare prose full width, tool work as a single collapsible "work group" line, errors as an in-place alert that clamps long messages with an expander.
- **Skeletons** use one stepped opacity breath (`animate-skeleton`, steps(4)) instead of a shimmer, so many bars cost a few frames per cycle.
- **Truncation helpers**: middle truncate for file names, start truncate for paths, `title` only when the text is actually cut.

## Typeface and type scale

- **UI: Inter Variable** (bundled, `@fontsource-variable/inter`), with `cv11` (single-storey a) and `ss01` (open digits) for a calmer, rounder texture at small sizes, `calt` on. Fallback: system UI stack.
- **Code and numbers that must align: JetBrains Mono Variable** (bundled). Inline code is 0.92 em of the surrounding size.
- Numbers that align vertically (times, counts, grades, percentages, sizes, keyboard hints) use `tabular-nums`.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `text-3xs` | 10 / 14 | 500 | key caps, counters inside badges |
| `text-2xs` | 11 / 16 | 500 | group labels in sidebar and settings, metadata, timestamps |
| `text-xs` | 12 / 16 | 400–500 | secondary lines, tooltips, menu shortcuts, buttons `sm` |
| `text-sm` | 13 / 20 | 400–500 | **the UI base**: rows, menus, inputs, buttons, settings text |
| `text-base` | 14 / 22 | 400 | chat prose and the composer |
| `text-lg` | 15 / 22 | 600, −0.01 em | page and dialog titles |
| `text-xl` | 18 / 26 | 600, −0.015 em | empty-state titles |
| `text-2xl` | 24 / 30 | 600, −0.02 em | first-run hero only |

Prose headings inside chat: h1 17/26 600, h2 15/24 600, h3 14/22 600; never larger than the page title. Weights are only 400, 500 and 600. No uppercase labels; group labels are sentence case, `text-2xs`, `font-medium`, muted.

## Spacing and density

- 4 px grid. Controls are 28 px (`h-7`) by default and 24 px (`h-6`) in toolbars; rows (sidebar, menus, lists) are 28 px; settings rows 44 px minimum with 12 px vertical padding.
- Title bar 40 px (macOS traffic lights sit inside the sidebar's top 40 px, inset 76 px).
- Sidebar 248 px (drag its edge to resize, 216–420, kept on this computer; double-click the edge for 248), main gutter 16 px, chat column max 46 rem (736 px), settings content max 42 rem.
- Gaps: 2 px between rows, 6 px between controls in a row, 12 px between groups, 24 px between sections.

## Colour tokens

Neutral zinc with one cobalt accent (the app icon's), used sparingly: primary buttons, selected indicators, focus rings, links. Status colours only for status.

| Token | Light | Dark |
|---|---|---|
| `--background` (canvas) | `#ffffff` | `#0c0c0d` |
| `--sidebar` | `zinc-50` `#fafafa` | `#111112` |
| `--card` (composer, popovers, cards) | `#ffffff` | `#161618` |
| `--popover` | `#ffffff` | `#18181a` |
| `--foreground` | `zinc-900` | `zinc-100` |
| `--muted-foreground` | `zinc-500` | `zinc-400` |
| `--subtle-foreground` (hints, placeholders) | `zinc-400` | `zinc-500` |
| `--muted` / `--accent` (hover, fills) | `zinc-100` | `white / 5%` |
| `--border` | `zinc-200` | `white / 8%` |
| `--input` (control borders) | `zinc-300` | `white / 11%` |
| `--primary` | `oklch(0.52 0.19 262)` | `oklch(0.64 0.17 262)` |
| `--message` (user bubble) | `zinc-100` | `#1c1c1f` |
| `--destructive`, `--warning`, `--success`, `--info` | red-600, amber-600, emerald-600, blue-600 | red-400, amber-400, emerald-400, blue-400 |
| each status `-surface` | 7 % of the colour | 14 % of the colour |

Dark mode follows the system unless Settings › Appearance picks one (`.dark` on `<html>`).

## Radius and borders

- `--radius` 8 px. Controls and inputs 7 px (`--control-radius`); rows and menu items 6 px; popovers and menus 10 px; cards and the composer 12 px; dialogs 14 px; pills and avatars full.
- Borders are 1 px hairlines in `--border`; inputs use `--input`. Elevation is a border plus at most `shadow-xs` in light mode and no shadow in dark (borders do the work). Popovers get `shadow-lg/5`.

## Icons

Chosen per place; within one surface the stroke and size are consistent. Lucide (stroke 1.75 at 16 px, 2 at 14 px) is the chrome default because its geometry matches Inter; Phosphor (regular weight) fills in where Lucide has no precise glyph; brand marks come from the provider logos in `assets/providers/` (Simple Icons sources noted there).

| Place | Icon | Why |
|---|---|---|
| New chat | Lucide `SquarePen` | the "compose" convention T3 and Linear use |
| Search | Lucide `Search` | |
| Sidebar toggle | Lucide `PanelLeft` | mirrors the panel it moves |
| Settings | Lucide `Settings2` | sliders read as preferences, not system |
| Conversation menu: Rename · Reset title · Pin / Unpin · Delete | Lucide `PencilLine` · `RotateCcw` · `Pin` / `PinOff` · `Trash2` | |
| Pinned mark | Phosphor `PushPinSimple` (fill) 12 px | reads at gutter size where Lucide's outline pin doesn't |
| Space switcher | coloured square with the space initial + Lucide `ChevronsUpDown` | spaces are identities, not files |
| Views: Chat · Study · Grades · Plan · Courses | Lucide `MessageSquare` · Phosphor `Cards` · Lucide `ChartNoAxesColumn` · Lucide `CalendarDays` · Phosphor `GraduationCap` | flashcards and courses have no exact Lucide glyph |
| Attach | Lucide `Paperclip` | |
| Send / Stop | Lucide `ArrowUp` / filled square | |
| Model picker | provider logo; CLIs: Claude, OpenAI, Gemini marks; chevron `ChevronDown` 12 px | the logo names the provider |
| Effort | three-bar glyph (custom, after T3's EffortGlyph) | levels read at a glance |
| Tool work | Lucide `FileText` read · `FolderTree` list · `Search` search · `SquareTerminal` command · `FilePen` write · `Wrench` other | one glyph per tool category |
| Approval | Lucide `FilePen` (write) | |
| Access request | Lucide `KeyRound` | |
| Lesson plan · question | Phosphor `Path` · Lucide `CircleHelp` | |
| Errors | Lucide `CircleAlert` (error), `TriangleAlert` (warning), `WifiOff` (core lost), `KeyRound` (missing key) | the icon says the kind |
| File kinds | Lucide `FileText`, `FileImage`, `FileCode`, `FileSpreadsheet`, Phosphor `FilePdf` | |

## Loading

- **Lists** (threads, decks, courses, providers): skeleton rows of the same height as real rows, with title bars of varied width (62 %, 48 %, 71 %…), never more than the space can hold.
- **Conversation**: two skeleton turns (a short right-aligned bubble, three prose lines) while `thread_load` runs; nothing for loads under 150 ms (`useDelayed`).
- **Streaming**: text appears as it arrives; before the first token the reply shows a `Thinking` label with a soft shimmer and the elapsed seconds (tabular); tool activity replaces it with the tool's label. The caret is not drawn.
- **In-place work** (saving, checking a key, signing in): the button keeps its width and swaps its label for a 14 px spinner + present participle ("Checking…").
- **Long jobs with progress** (import, generating a deck): a 2 px determinate bar at the top of the card plus a one-line step label with `done/total` in tabular numbers.
- **The app's first paint**: the shell (sidebar frame and title bar) renders immediately; only its lists skeleton. There is no full-screen spinner.

## Errors

Each error is sized to where it happened and says what to do next.

| Level | Where | Look |
|---|---|---|
| Field | under the input | 12 px `text-destructive` with `CircleAlert` 12 px; the input border turns destructive |
| Row | inside the row that failed | muted text "Couldn't load" + inline `Retry` link button; the row keeps its height |
| Surface | top of the panel or in the timeline where the reply failed | `Alert` (status surface tint + hairline border + icon), title one line, message clamped to 2 lines with "Show more", action buttons right |
| Connection | above the composer | warning alert "Reconnecting to Phaethon's core…" with a spinner; disappears on reconnect |
| Background | toast, bottom right | for things the user isn't looking at (an update failed, an export finished with problems) |

Agent errors map their `ErrorCode` to a title and an action: `noApiKey`/`apiKey` → "Add a key" (opens Settings › Providers), `rateLimit` → "Rate limited, try again in Ns" (counts down), `network` → "Retry", `missingCli`/`notLoggedIn` → "Open coding agents", `billing` → "Open billing page" when known, everything else → "Retry". Raw JSON errors are unwrapped to their message.

## Overflow and wrapping

| Text | Behaviour |
|---|---|
| Conversation titles, space names, model names, course names | one line, ellipsis; full text in a tooltip only when cut |
| File names | middle truncation keeping the extension (`lecture-notes…week-3.pdf`) |
| Paths | start truncation keeping the end (`…/courses/m301/hw6.pdf`) |
| Chat prose | wraps; long tokens break with `overflow-wrap: anywhere` |
| Code blocks, tables, display math | scroll horizontally inside their own frame; the page never scrolls sideways |
| User messages | wrap; longer than 12 lines clamp with a "Show more" toggle |
| Error and tool details | 2-line clamp with expander; tool output in a mono block that scrolls at 240 px |
| Toasts | title one line, description up to 3 lines |
| Numbers in rows | tabular, never wrap |
| Buttons | never wrap; labels are short enough not to need it |

## Per-conversation model

Each conversation remembers the provider/model (and reasoning effort) it uses. A new conversation starts with the last one picked anywhere. Coding agents (Claude Code, Codex, Gemini CLI) are entries in the same picker. The core keeps the choice next to the conversation (`.phaethon/model` for the current one, `threads/<id>.model` for archived ones), moving with it like the CLI session file, so existing thread files are untouched and old cores ignore it; with no choice saved the old behaviour applies (vault backend and space model).

## Conversation titles and pins

A conversation's own title and its pin live beside it like its model (`.phaethon/meta` for the current one, `threads/<id>.meta` for archived ones, JSON `{title?, pinned?}`), written by `thread_rename` (empty goes back to the title from the first message) and `thread_pin`. `threads_list` reports `title` (the given one when set), `renamed` and `pinned`. Old cores ignore the file.

## Where things are (Nov 11, 2026)

- Tokens and prose styles: `src/web/src/index.css`. Primitives: `src/web/src/components/ui/` (T3 Code, MIT). Shared pieces: `components/errors.tsx`, `skeletons.tsx`, `toast.tsx`, `truncate.tsx`, `provider-icon.tsx`.
- Shell: `app/` (`Shell`, `Sidebar`, `Header`, `CommandPalette`, `store.ts`). Chat: `features/chat/` (`store.ts` per-space state, `catalog.ts` + `components/ModelPicker.tsx` per-conversation model). Study, Grades, Plan, Courses, the file viewer, first run and Settings live under `features/`.
- Checks: `pnpm typecheck`, `pnpm test`, `pnpm test:ui` (Playwright specs in `e2e/*.spec.ts` against the real core with `PHAETHON_FAKE_PROVIDER`), `node scripts/capture.mjs out.png` for the real Electron window (`PHAETHON_CAPTURE_SKIP_SETUP=1`, `PHAETHON_CAPTURE_THEME=dark|light`). `pnpm dev`'s Vite page with `#mock` runs the UI against the fake core in `dev/mocks/`.

### Known gaps
- Cancelling a course-site sign-in only stops waiting: the core has no `lms_connect_cancel`, so the sign-in window stays until closed.
- Cancelling deck or quiz generation from Study stops listening; there is no core cancel for `study_make_deck` / `study_make_quiz` yet.
- Teaching turns (tutor and plan) always reason at high effort; the composer's effort applies to plain chat.
