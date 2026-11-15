# UI rules

The contract `src/web` follows. Tokens live in `src/web/src/index.css`, primitives in `src/web/src/components/ui/`. When a rule and the code disagree, fix one of them.

## Direction

- Flat, minimal, condensed SaaS (T3 Code, Linear, Raycast): hairline borders, small type, few colours, nothing decorative that carries no information.
- Every async action shows its state: pending, working, done, failed. Nobody should wonder whether something happened.
- Motion is short (120–220 ms), springy or ease-out, interruptible, and calm. Lists and popovers use presence; nothing animates per keystroke.
- Accessibility audits don't drive design decisions, but keyboard paths and roles stay correct.

## Stack

- shadcn on Base UI (`components.json`: base-mira, `@base-ui/react`, Tailwind v4). Every UI part is built from a primitive in `components/ui/`. A hand-rolled widget gets ported to the matching primitive and keeps its behaviour.
- T3 Code's web app (MIT) is the reference for chat, composer, menus and motion. Copied code keeps its first-line notice and an entry in `THIRD_PARTY_NOTICES.md`. coss ui is AGPL: don't copy from it.
- Animation uses `motion/react`. CSS transitions are fine for simple hover and focus states.

## Tokens

No raw values in components. Use tokens and the Tailwind scale. Adding a one-off pixel, breakpoint or colour to fix one place is a bug, even when it works.

- **Colour**: `oklch()` or `oklab()` only, everywhere in `src/web`, including SVG assets. Tailwind's `white` and `black` are redefined as oklch. Mixes use `color-mix(in oklab, …)`. The neutrals are zinc, the one accent is cobalt (`--primary`: `oklch(52% 0.19 262)` light, `oklch(64% 0.17 262)` dark), and status colours (`--destructive`, `--warning`, `--success`, `--info`) are used only for status. Dark mode redefines the same tokens under `.dark`; `.light` forces light tokens in a subtree.
- **Radius**: `--radius` is 10 px. The steps are `rounded-xs` 4, `sm` 6, `md` 8, `lg` 10, `xl` 14, `2xl` 16, `3xl` 20, and `rounded-control` is 9. Change roundness through the tokens only.
- **Type**: Inter Variable (`cv11`, `ss01`, `calt`), with JetBrains Mono for code and aligned numbers. The scale is `text-3xs` 10, `2xs` 11, `xs` 12, `sm` 13 (the UI base), `base` 14 (chat prose and the composer), `lg` 15 (titles), `xl` 18, `2xl` 24. Only weights 400, 500 and 600 are used. Tracking comes from `tracking-title`, `tracking-heading` and `tracking-hero`. Labels are in sentence case, never uppercase. Numbers that line up use `tabular-nums`.
- **Geometry**: the grid is 4 px. Controls are `h-7`, or `h-6` in toolbars; rows are 28 px. The title bar is `--titlebar-height`, the sidebar `--sidebar-width`, the chat column `--chat-max-width`, settings `--settings-max-width`. The macOS traffic-light inset is `--traffic-light-inset`, the only place that number appears.
- **Layers**: `z-(--z-sheet)` < `--z-dialog` < `--z-popup` < `--z-tooltip` < `--z-toast`. Popups use `shadow-popup`.
- **Responsive**: use container queries on the surface (`@container/header`, `@container/composer`), not viewport pixel breakpoints.

## Icons

- Pick the clearest icon for each place from any library: Lucide, Phosphor, Tabler, Hugeicons. Brand marks come from `assets/providers/`.
- Size icons with `size-*` only. Use `size-4` in chrome, rows and menus, `size-3.5` in small buttons and chips, and `size-3` inline.
- Stroke and weight are set centrally (`components/icon.tsx`, `--icon-stroke` in `index.css`): Lucide is drawn thin, a little heavier at 12 px, and Phosphor uses its Light weight. Don't pass `strokeWidth` or `weight`, except `weight="fill"` for a solid status mark.
- Shared glyphs: the views are Phosphor `ChatsTeardrop`, `Cards`, `ChartLineUp`, `CalendarDots` and `GraduationCap`. Settings sections are Phosphor. Work steps use `BookOpenText` (read), `FolderOpen` (list), `MagnifyingGlass` (search), `PencilSimpleLine` (write), `TerminalWindow` (command) and `Sparkle` (other).
- **File kinds** (`features/viewer/FileIcon.tsx`): Lucide `FileText`, `FileImage`, `FileCode`, `FileSpreadsheet`, and Phosphor `FilePdf`.

## Shell

- There is one title bar, rendered by `Shell` (`AppHeader`). It shows space / title on the left, then the page's actions, then the view tabs pinned to the right edge. The tabs never move. Pages fill the title and actions by rendering `<Header title actions />` anywhere in their tree, which portals into the bar only while that page is visible.
- Pages are `Pane`s in `Shell`. Chat is always mounted, and views marked `keepAlive` in `app/views.tsx` stay mounted, hidden, after their first visit. A kept-alive page must not listen to global keys; check `useViewActive()` before reacting to anything global. The page that becomes visible fades and lifts in.
- Settings is a page inside the shell, so the sidebar stays. You leave it with Esc, Back, ⌘, (Ctrl+, elsewhere), any view tab or any sidebar row.

## State and feedback

- **Loading**: skeletons match the layout they stand in for and appear only after 150 ms (`useDelayed`). There's no full-screen spinner, and the shell paints immediately.
- **Buttons**: `<Button pending>` keeps its width and shows a spinner; `<Button success>` shows a check. `AsyncButton` and `useAsyncAction` run an action through pending, then a check for 1.2 s, or a shake plus an error toast.
- **Toasts** (`components/toast.tsx`): bottom right, at most three, for things the user isn't looking at. The icon pops in and a hairline counts down the time left (paused while hovered). `toast.promise` turns a spinner into the result.
- **Copy**: the glyph swaps for a check, or a toast says "Copied" when the copy came from a menu.
- **Errors**: say what happened and what to do next, sized to the surface.

| Level | Where | Look |
|---|---|---|
| Field | under the input | `text-destructive` line with an icon; the input border turns destructive |
| Row | inside the row | muted "Couldn't load" + inline Retry; the row keeps its height |
| Surface | top of the panel, or where a reply failed | `SurfaceError`: tinted alert, one-line title, message clamped to 2 lines, actions on the right |
| Connection | above the composer | "Reconnecting to Phaethon's core…" with a spinner |
| Background | toast | for work the user isn't watching |

Agent errors map their code to a title and an action (add a key, retry with countdown, open coding agents, …); raw JSON errors are unwrapped to their message.

## Overflow

| Text | Behaviour |
|---|---|
| Titles, space, model and course names | one line, ellipsis, tooltip only when cut |
| File names | middle truncation keeping the extension |
| Paths | start truncation keeping the end |
| Chat prose | wraps; long tokens break anywhere |
| Code, tables, display math | scroll sideways inside their own frame; the page never does |
| Inline math too wide to break | its own sideways scroll (`katex-wide`) |
| User messages | clamp at 12 lines with "Show more" |
| Tool detail | 3-line clamp, mono |
| Numbers in rows, buttons | never wrap |

## Interaction

- **Right-click** works everywhere it makes sense. App menus use `components/ui/context-menu.tsx`. Messages offer copy, copy as Markdown, edit and retry. Code blocks offer copy code and copy as Markdown. Links offer open and copy. Files offer open, open in the default app, show in folder and copy path. Right-clicking selected text or a text field falls through to the system menu from `src/desktop/main.ts` (spelling, cut, copy, paste).
- **File references** (links, inline code paths, tool steps, attachments) are `FileChip`s (`components/file-chip.tsx`). Clicking one opens the in-app viewer. Web and mail links open in the browser. `features/chat/lib/links.ts` decides which is which.
- **Composer autocomplete**: `@` lists the space's files (core `space_files`) and `/` at the start of a line lists commands (teaching modes, new, model, attach). The textarea keeps focus: arrows move, Enter or Tab picks, Esc dismisses.

## Chat

- The timeline shows user turns as a muted bubble on the right that grows in when sent. Assistant turns are bare full-width prose, revealed at a steady pace while streaming (`useSmoothText`).
- **Work in progress** is a friendly line, in plain words ("Reading week 6 notes…"), with breathing dots, the step's elapsed time, and after 8 s a reassuring second line. The words cross-fade when the step changes. Before the first token it says "Thinking…".
- **Finished work** is one quiet summary ("Read 2 files, searched once"). It opens to the steps in plain words, each file a chip. Tool labels, raw paths and output appear only when you turn on Settings › General › Show technical details.
- Each conversation keeps its own model (and effort where the model has one), defaulting to the last one picked. Coding agents (Claude Code, Codex, Gemini CLI) appear in the same picker.

## Checks

`pnpm typecheck`, `pnpm test`, `pnpm test:ui` (Playwright in `e2e/*.spec.ts` against the real core with a scripted model), `pnpm dev` with `#mock` for the fake core, and `node scripts/capture.mjs out.png` for the real Electron window. Look at light and dark.
