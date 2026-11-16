# UI rules (v2)

The binding contract for `src/web`. Tokens live in `src/web/src/index.css`, primitives in `src/web/src/components/ui/`, art in `src/web/src/components/art.tsx`, icons in `src/web/src/components/icons.ts`. When a rule and the code disagree, fix one of them. `#gallery` in a dev build (`pnpm exec vite`, then `http://localhost:<port>/#gallery`) shows every primitive in both themes.

## Direction

- **The reference screenshots are the acceptance bar.** They are the owner's set (Conduit, Alpaca, Operator); each blueprint below names the ones it follows by the first four characters of the file's second id (`refs/…-a163…` is "a163"). A screen is done when it matches its references side by side in layout, spacing, type and icon style, in light and dark.
- Light theme first: a soft grey canvas, the app in one white panel with a large radius and a hairline, generous whitespace, near-black text, very few colours. Dark mode is derived from the same tokens and has to look designed, not inverted.
- Near-black pills are the primary action. Blue appears only for toggles, links, selection, focus and status, and for the rare "go" button next to a primary (Upgrade).
- Abstract art (grainy pastel mesh gradients, a faint dot matrix) fills empty space, hero cards and onboarding. Nothing that reads as "AI art": no faces, robots, glowing brains or glyph soup.
- Every async action shows its state: pending, working, done, failed. Motion is calm and short and always tells you something happened.
- Accessibility audits don't drive design decisions, but keyboard paths, roles and names stay correct.

## Stack

- shadcn on Base UI (`components.json`: base-mira, `@base-ui/react`, Tailwind v4). Every UI part is built from a primitive in `components/ui/`. A hand-rolled widget gets ported to the matching primitive and keeps its behaviour.
- T3 Code's web app (MIT) remains the reference for chat behaviour, composer, menus and motion. Copied code keeps its first-line notice and an entry in `THIRD_PARTY_NOTICES.md`. coss ui is AGPL: don't copy from it.
- **React Bits is inspiration only.** Its licence is MIT plus the Commons Clause; never copy its code. Build the equivalent ourselves (the mesh, grain and dot matrix in `components/art.tsx` are ours).
- Animation uses `motion/react`. CSS transitions are fine for hover and focus.

## Tokens

No raw values in components: use these tokens and the Tailwind scale. A one-off pixel, breakpoint or colour that fixes one place is a bug even when it works. Generated values (art blob positions, chart segment widths, a space's hue) are data, not styling, and may be inline.

### Colour

`oklch()` or `oklab()` only, everywhere in `src/web`, including SVG. Tailwind's `white` and `black` are redefined as oklch. Mixes use `color-mix(in oklab, …)`. Neutrals are true greys (chroma 0). `.dark` redefines the same names; `.light` forces light in a subtree.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | `oklch(96.4% 0 0)` | `oklch(12.8% 0 0)` | the window behind the app panel |
| `--tab-strip` | `oklch(96.4% 0 0)` | `oklch(17.5% 0 0)` | the strip behind open tabs (title bar, viewer); the active tab is the page's colour |
| `--background` | `oklch(100% 0 0)` | `oklch(17.2% 0 0)` | the app panel, pages, sidebar |
| `--card` | `oklch(100% 0 0)` | `oklch(19.6% 0 0)` | cards, the composer |
| `--well` | `oklch(98.2% 0 0)` | `oklch(100% 0 0 / 3%)` | grey inset boxes, stat tiles, card footers, the search field |
| `--popover` | `oklch(100% 0 0)` | `oklch(21% 0 0)` | menus, popovers, dialogs |
| `--foreground` | `oklch(23% 0 0)` | `oklch(95.5% 0 0)` | text |
| `--muted-foreground` | `oklch(51% 0 0)` | `oklch(70% 0 0)` | secondary text, descriptions, icons |
| `--subtle-foreground` | `oklch(66% 0 0)` | `oklch(54% 0 0)` | placeholders, meta, times |
| `--ink` / `--ink-foreground` | `oklch(25.5% 0 0)` / `oklch(99% 0 0)` | `oklch(94% 0 0)` / `oklch(18% 0 0)` | primary buttons (dark pill; a light pill in dark mode) |
| `--message` / `--message-foreground` | ink / ink-foreground | `oklch(26% 0 0)` / `oklch(95.5% 0 0)` | the user's chat bubble |
| `--primary` | `oklch(61.5% 0.205 254)` | `oklch(66.5% 0.19 254)` | the blue: switches, links, selected state, focus ring, info |
| `--muted`, `--secondary` | `oklch(96.4% 0 0)` | `oklch(100% 0 0 / 5–6%)` | tab and segmented tracks, secondary buttons |
| `--accent` | `oklch(96.2% 0 0)` | `oklch(100% 0 0 / 6%)` | hover |
| `--row-selected` | `oklch(94.5% 0 0)` | `oklch(100% 0 0 / 8%)` | the selected sidebar row, the selected pill tab |
| `--border` | `oklch(92.6% 0 0)` | `oklch(100% 0 0 / 8%)` | every hairline |
| `--border-strong` | `oklch(88% 0 0)` | `oklch(100% 0 0 / 14%)` | hovered cards, the raised pill's edge |
| `--input` | `oklch(90.5% 0 0)` | `oklch(100% 0 0 / 11%)` | field borders, the off switch |
| `--keycap` | `oklch(96% 0 0)` | `oklch(100% 0 0 / 8%)` | keycaps |
| `--dot-matrix` | `oklch(23% 0 0 / 9%)` | `oklch(100% 0 0 / 7%)` | the dot texture |
| `--destructive` | `oklch(60.5% 0.215 25)` | `oklch(65% 0.21 24)` | errors, delete |
| `--warning` | `oklch(76% 0.16 68)` | `oklch(80% 0.16 75)` | needs you, pending |
| `--success` | `oklch(66% 0.17 150)` | `oklch(72% 0.17 152)` | done, connected, "Active" |
| `--info` | = `--primary` | = `--primary` | information, "Synced" |
| `--chart-1…6` | amber 82°, orange 44°, sky 232°, teal 178°, pink 357°, violet 292° | same hues, a touch softer | categorical data only, never status |

Each status colour has a `-foreground` for text on white and is used as a tint (`bg-success/8 text-success-foreground`) for badges, as in "Synced", "Pending", "Active".

Art palettes are tokens too (`--art-{sky,dawn,meadow,lilac,ember}-{0…4}`): a base and four mesh colours each, soft pastel (L 62–95 %, C ≤ 0.16). They are the same in both themes; `--art-veil` lays a 22 % panel-coloured veil over art in dark mode.

### Radius

`--radius` is 10 px. Steps: `rounded-xs` 4, `sm` 6, `md` 8, `lg` 10, `xl` 14, `2xl` 16, `3xl` 20, `4xl` 24, `rounded-control` 10. Semantic: `rounded-card` (16, every card), `rounded-panel` (20, the app panel, hero and art cards), `rounded-full` (text buttons, pills, the thought toggle). Inputs and the search field are `rounded-lg`; menu rows `rounded-sm`; tab pills `rounded-md` inside a `rounded-lg` track.

### Spacing

The 4 px grid (Tailwind's scale). Card padding is `p-5` (20), compact cards `p-4`; card-to-card gaps `gap-3` (12) in a grid, `gap-4` in a stack; page sections `gap-8` to `gap-10`; page side padding `px-8` (`px-6` under `@3xl`). Rows are 28 px (`h-7`); legend and step rows 28–32; toggle rows `py-3`; settings rows `min-h-10 px-3 py-2` (see Settings).

### Type

Inter Variable (`cv11`, `ss01`, `calt`), JetBrains Mono for code and aligned numbers. Weights 400, 500 and 600 only; headings are 400–500, never bold. Sentence case everywhere, never uppercase labels.

| Class | Size / line | Use |
|---|---|---|
| `text-3xs` | 10 / 14 | keycap glyphs in tight spots |
| `text-2xs` | 11 / 16 | sidebar times and counts |
| `text-xs` | 12 / 16 | chips, tags, meta, hints |
| `text-sm` | 13 / 20 | the UI base: rows, labels, descriptions, buttons |
| `text-base` | 14 / 22 | chat prose, the composer, card body, tool rows |
| `text-lg` | 15 / 22 | card titles in lists, dialog titles |
| `text-xl` | 18 / 26 | page titles ("Artifacts" row) |
| `text-2xl` | 24 / 30 | stat numbers, the welcome question, onboarding titles |
| `text-3xl` | 30 / 36 | the one hero number of a page (a grade, a score) |

Tracking: `tracking-title` (-0.01em) on 15–18 px, `tracking-heading` (-0.015em) on 24, `tracking-hero` (-0.02em) on 30. Numbers that line up use `tabular-nums`.

### Shadows and borders

Flat. Hairlines carry all the structure: `border` is 1 px `--border` (light, never heavy); cards, the composer, inputs and tables all use it, and a hover is a background change (`bg-accent`), never a border or a shadow.

- `shadow-popup` is the only shadow, and only on floating layers: menus, popovers, tooltips, dialogs.
- Nothing else casts a shadow: no cards, buttons, pills, tabs, inputs or switches. No glows or gradients on chrome.
- Scrollbars are thin and only there while the pointer is over what scrolls. A page that scrolls uses `page-scroll` (the lane is reserved on both edges, so its column stays centred); the chat uses `scroll-quiet` (no scrollbar; the history rail stands in).

### Geometry and layers

`--titlebar-height` 48, `--footer-height` 45 (every bottom bar beside the sidebar: border-box, the 1 px hairline on top, then a 28 px row with 8 px either side, so the hairlines and rows line up across columns), `--sidebar-width` 248 (user-resizable 216–420), `--chat-max-width` 736, `--page-max-width` 768, `--page-wide-max-width` 1024, `--settings-max-width` 672, `--traffic-light-inset` 88 (17 + the 54 px button group + 17; the web side of `trafficLightPosition`). Container sizes: `titlebar-brand` 128 (the sidebar column's content box from which the wordmark spells out). Layers: `z-(--z-sheet)` < `--z-dialog` < `--z-popup` < `--z-tooltip` < `--z-toast`. Responsive rules use container queries on the surface (`@container/header`, `@container/composer`, `@container/page`), not viewport breakpoints.

### Motion

- Durations 120–240 ms; springs (`stiffness 420–520, damping 32–42`) for layout, `--ease-out-soft` for CSS. Everything interruptible; nothing animates per keystroke.
- Pages fade in, in place (no lift: switching tabs never moves anything). Lists grow rows in and fold them away. Tabs and segmented pills glide. Steps fade up 2 px as they arrive. Stacked bars grow from the left once. Art drifts only where `animate` is set (onboarding, the welcome hero), over 28 s, and stops under reduced motion.
- `prefers-reduced-motion` turns animation off globally (index.css) and `useReducedMotion()` skips springs.

## App frame

The app fills the window edge to edge: no inset panel, no outer canvas, no rounded border or shadow around it. One window, one surface.

```
┌ window ────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  Phaethon       ▯ │ ╭💬 conversation ×╮ Study × │ Settings ×  + …………………  actions │
│                          │─╯                 ╰─────────────────────────────────────────│
│ ● School             ⇕   │ main: page, faint dot matrix fading from the top            │
│ [🔍 Search   ⌘K]  ✎      │                                                             │
│ ⧉ Study                  │                                                             │
│   Today                  │                                                             │
│ ○  conversation          │                                                             │
│──────────────────────────│                                                             │
│ ⚙ Settings               │                                                             │
└──────────────────────────┴─────────────────────────────────────────────────────────────┘
```

- The title bar runs across the top (48 px). Its left end is exactly the sidebar's column: the same width (live while the sidebar is dragged, sliding with it when it opens or closes), the sidebar's colour and its hairline on the right, and no hairline under it, so the sidebar runs from the window's top to its bottom. The rest of the bar is the tab strip (`--tab-strip`, hairline along its bottom) over the main column; the tabs start at the main column's edge.
- macOS traffic lights sit in the column's left end, centred on the 48 px bar and as far from the window's edge as from the mark: `trafficLightPosition` 17, 17 in `src/desktop/main.ts` (the buttons are 14 px, so 48 / 2 − 7), and the column takes `pl-(--traffic-light-inset)` (17 + 54 + 17 = 88) on macOS and `pl-4` elsewhere. Measured in the mock with the platform set to macOS: the buttons span x 17–71 and y 17–31, the mark x 88–102 and y 17–31.
- The native window background is the `--background` colour so the first frame matches.
- `DotMatrix` sits behind the top of every page (absolute, `--dot-matrix`, fading by 96 px). Pages keep a transparent background so it shows.
- Pages fade in, in place, when they become visible; hidden pages stay mounted (keep-alive views) and out of the title bar.
- Never draw a window inside the window: no inset frames, padded canvases or card-wrapped app shells.

### Title bar (`app/Header.tsx`)

One row, nothing in it moves when the page changes. In the sidebar's column: the wordmark (`BrandWordmark`: the mark as the P of "Phaethon", 14 px at the cap height of 18 px Inter, "haethon" in 600 on the same baseline) while the column has room, else the mark alone, and the Show/Hide sidebar icon button at the column's right end, over the sidebar's New chat. With the sidebar hidden the column shrinks to the mark, the toggle and Search (the + after the tabs is New chat). Then the open tabs, a + (New chat in the space on show, keys in its tooltip) after the last, and the page's actions slot (`Button size="sm"` pills, `icon-sm` ghost icons) at the right. There is no search field here: the sidebar has the one search field, and ⌘K opens the palette from anywhere.

- **Open tabs** (`tablist` "Open pages", `app/store.ts` `tabs`, drawn with `components/ui/page-tabs.tsx`): every open page is a tab, like a browser's: a conversation (its title, or "New chat"), a page (Study, Grades, Plan, Courses) or Settings. Every tab has a shape: 40 px tall at the bottom of the strip, icon + truncated label + ×. Inactive tabs sit on the strip between 16 px separators (hidden beside the active or hovered tab) and fill in (`bg-foreground/5`, `rounded-lg`) on hover; the active tab is the page's colour with a hairline edge and `rounded-t-lg` corners, breaking the strip's hairline, its lower corners flaring into it, so it reads as part of the page. **Nothing moves when you switch:** every tab is the same width, up to 200 px, shrinking together only when the bar can't hold them (down to 112 px, then the strip scrolls sideways to keep the active tab in view); the page's actions get a fixed 224 px share at the right (`min-w-56`), so pages with more or fewer actions never resize the tabs; the active and inactive tabs are the same box (same 1 px border, transparent when inactive, same padding, the × slot always reserved and shown on hover), so choosing a tab only changes colours. The `+` follows the last tab. No shadows. A conversation opened by a plain click is a preview (italic label) and the next plain click on another conversation reuses its tab; a sent message, a double-click, ⌘-click or middle-click keeps it. Pages and Settings always open kept. Right-click a tab for Keep open, Close, Close others, Close tabs to the right and Reopen closed tab. Ctrl+Tab walks the tabs, ⌘W closes the active one, ⇧⌘T reopens the last closed, arrows move within the strip. Tabs persist across launches. Every open tab stays mounted (its state, scroll and running replies survive); only the active one is shown.
- Pages render `<Header actions />`; it portals into the bar only while the page is visible. The tab is the page's title; the bar has no title slot.

### Sidebar (`app/Sidebar.tsx`, `app/sidebar/`, `components/ui/sidebar.tsx`)

After 3940, a163, 9334 (rows, section labels, recents) and e0fb (status dots).

- No top row of its own: the title bar's left end is the sidebar's column and holds the wordmark and the toggle. Content starts `pt-2` under it.
- **One space at a time.** First the space switcher (`app/sidebar/space-switcher.tsx`): a 32 px row with the space's dot, its name (`font-medium`), a blue dot when another space has a new reply or is replying, and `icons.chevronsUpDown`. It opens a menu: "Spaces" with every space (dot, name, its replying / needs-you / new-reply marks, a tick on the one on show, ⌘1–9 on the rest), then New space, New chat in the space, Show folder, Space settings. Only the chosen space's conversations are listed, so spaces never compete for the sidebar's height. A switch sweeps a thin blue line under the switcher (and keeps sweeping while the space's list loads), the name and dot pop in, and the list comes in fresh with its labels and rows stepping down into place (240 ms each, 22 ms apart, at most 12 steps).
- Then one row: the search field (`h-7 rounded-lg border bg-well`, magnifier, "Search", the ⌘K keys as plain subtle text that open the palette) and New chat beside it as an icon button (`icons.newChat`, `size-7 rounded-lg`, pressed on `bg-row-selected` while the space's new chat is on show; its keys in the tooltip). Typing narrows the space's conversations by title (loaded rows at once, the core's matches from further back after a pause); Esc clears, ↓ moves into the matches, Enter opens the first, or the palette when nothing matches. While there is text, a quiet row under the list offers "Search everything for “…”" (the palette, starting from the text). This is the app's only search field.
- Then the space's pages (Study, Grades, Plan, Courses) as `SidebarMenuButton` rows with their icons, keys on hover and `aria-current="page"` on the open one (list "Views"; only for a space with study tools). These rows stay put; the conversations scroll under them, 12 px below.
- The conversations are grouped by recency under labels like a163's "Recents" (`text-xs text-subtle-foreground`, aligned with the titles, 8 px above every label but the first): Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, then one per month ("October", "October 2025" in an earlier year). The current group's label sticks to the top; the next label slides over it while the stuck one's text fades, so a label is never shown cut in half, whatever the window's height. Rows: 28 px, `text-sm`, `rounded-md`, hover `bg-accent`, selected `bg-row-selected`. Status sits in the icon column: a faint hollow ring for an idle conversation and a blue dot for a new reply (3940's dot column), the spinner arc for replying, an amber dot for needs-you, the error glyph for failed, a pin for pinned.
- Scale: the list is windowed (`app/sidebar/`, @tanstack/react-virtual over a fixed-height layout), so a space with thousands of conversations renders only the rows on screen. Older pages load as the end of the loaded run comes within two screens of the view, shown as one quiet skeleton row (a failed page turns it into a row error with Retry). A conversation opened from search scrolls into view, read on its own when it is older than the loaded pages. What is on screen holds still when rows above it change (a pin, a delete, a reply moving a row up, a page arriving): the list scrolls to make up for it instead of sliding. New rows fade in and the rest slide; rows scrolling in or out, and pages arriving, never animate. Cut titles share one tooltip beside the row, shut while a menu is open. A sticky group label masks a short edge under it while stuck, so cut-off text never peeks out beneath it.
- Trailing text (time, count, shortcut) is `text-2xs text-subtle-foreground tabular-nums` and gives way to hover actions.
- The update pill sits just above the footer. Footer (`--footer-height`, hairline above): the Settings row (its keys appear on hover; selected while Settings is open). Setting up a model is onboarding's job; the sidebar never nags about it.
- Resize rail, offcanvas collapse, keyboard row navigation (arrows, Home, End scroll the list as they go; ↑ from the first row goes to the search field, ↑ from it to the switcher; F2 renames; Delete asks), right-click menus (one shared menu for the whole list): unchanged behaviour.

### Command palette (`app/CommandPalette.tsx`)

- ⌘K, or the keys in the sidebar's search field (starting from what was typed there). Groups: Conversations (full-text, every space, with the matched snippet), Spaces, Views (in a space with study tools, with their keys), Actions. Rows use the menu row style with `icons.*` glyphs; meta on the right in `text-subtle-foreground`.
- Searching shows the spinner in the empty state and the footer; a failure says so with the error glyph. The footer lists ↑↓ move, ↵ open, esc close.

## Primitives

All in `components/ui/` unless noted. `#gallery` renders each.

| Primitive | Import | Rules |
|---|---|---|
| Button | `@/components/ui/button` | `default` = ink pill; `outline` = white pill with hairline; `accent` = blue pill (rare); `secondary` = grey; `ghost`, `ghost-muted`, `destructive`, `destructive-outline`. `shape` is `pill` for text sizes, `rect` (`rounded-control`) for icon, `xs`, `compact`, `micro` sizes; pass `shape="rect"` for a toolbar or in-card action ("Save", "Edit message"). `pending` and `success` keep their width. One `default` button per surface. |
| Card | `@/components/ui/card` | `Card` (`default`, `well`, `ghost`, `interactive`), `CardMedia` (art across the top), `CardHeader`, `CardTitle`, `CardDescription`, `CardAction` (top-right badge or button), `CardContent`, `CardFooter` (grey, hairline above, actions right). 16 px radius, `p-5`. |
| Tabs | `@/components/ui/tabs` | The one way to pick one of a few things: a grey track with a flat pill that slides to the chosen tab. Section tabs, value choices ("1W · 1M · All", "Quiz · Cards", a filter), everything. `size="sm"` for dense toolbars. Panels optional. There is no second picker or segmented component (open documents are `PageTab`s, which are not a picker). |
| Switch | `@/components/ui/switch` | Blue (`--primary`, the app's one blue) when on with a white thumb, `--input` when off. |
| Toggle row | `@/components/ui/toggle-row` | `ToggleRow title description checked onCheckedChange icon? pending?`. The row is the label. Stack in `divide-y` inside a Card. |
| Stat tile | `@/components/ui/stat-tile` | `StatTile label value unit? hint? delta? tone?` on `bg-well` with a soft hairline, label above a 24 px number. `StatGrid` lays them two across in a card, four across on a wide page. |
| Stacked bar + legend | `@/components/ui/stacked-bar` | `StackedBar segments` (12 px tall, 2 px gaps, `--chart-*` colours, grows in) and `BarLegend segments` (dot, label, value, "(percent)"), `percentOf`, `chartColor`. |
| Keycap and keyed actions | `@/components/ui/kbd`, `@/components/ui/key-actions` | `Kbd` is a small flat 16 px chip (`text-2xs`, faint tint, no border); `keycap` is the 20 px grey key of an approval choice. `KeyActions` + `KeyAction shortcut="Y"` is the split bar under an approval card; the card binds the keys. |
| Steps | `@/components/ui/step-list` | `ThoughtToggle state label open onOpenChange` (the "Thinking… / Thought 12s" pill: spinner, dark tick disc, or failed mark; chevron right when closed, down when open). `StepList open` with `Step state meta? detail?` on a 1 px rail (reasoning in words). `ToolSummary summary duration running open` is the quiet "18 tools, edited 5 files, ran 2 commands › … 6m 12s" line. `formatDuration`. |
| Work log | `@/components/ui/work-log` | After T3 Code's work log. `WorkLogList`, `WorkLogRow icon state label trailing? expanded onExpandedChange?` (a 28 px line; a chevron when it opens), `WorkLogDetails` (indented to the text, selectable), `WorkLogCommand` (a command as a row label), `WorkLogCommandBody command output full?`, `commandIsCut`. |
| Page tabs | `@/components/ui/page-tabs` | Open documents as a browser's tabs: `pageTabStripClassName` on the bar, `PageTabList`, `PageTab active icon label closeLabel onClose menu`, `PageTabNew`. The title bar's open pages and the viewer's open files. Not a picker (that is `Tabs`). |
| Spinner | `@/components/ui/spinner` | A faint ring with a turning arc. |
| Art | `@/components/art` | See Art. |
| Brand mark | `@/components/brand-mark` | `BrandMark` in Phaethon blue (`text-primary`); `BrandWordmark` is "Phaethon" with the mark as its P. |
| Icon | `@/components/icon`, `@/components/icons` | See Icons. |

Existing primitives (menu, dialog, alert-dialog, popover, select, combobox, autocomplete, command, tooltip, input, textarea, checkbox, radio-group, badge, alert, empty, skeleton, scroll-area, sidebar, toast) keep their API; they take the new tokens automatically. Menus and popovers are `rounded-xl`, `shadow-popup`, rows `rounded-sm h-7`, icons `size-4 text-muted-foreground` (ref 8386: Settings / Language / Docs / Apps / Logout with a "New" tint badge).

## Art

`components/art.tsx`, all seeded (same seed, same picture), all from `--art-*` tokens:

- `ArtCanvas palette seed grain weave animate`: eight layered radial gradients (four big soft fields, four brighter cores) over the palette base, film grain from SVG `feTurbulence` in soft light, optional woven 3 px grid (`art-weave`, the halftone look of 2c35 and d1d3), the dark-mode veil. Fills its box; put it in `CardMedia` or `absolute inset-0`.
- `ArtFrame palette seed`: a card set into an art panel; art shows on the top and left edges and the card runs off the bottom-right (b583, f510).
- `ArtTile`: a small rounded thumbnail for list leaders and onboarding steps (5ec7, a163's "Connect your channel").
- `DotMatrix seed`: the faint 2 px dot field on a 7 px grid that fades out at the top of pages (every Alpaca screen, 7cad, 9e25).
- `paletteFor(seed)` picks a palette for things that each want their own art (a course, a deck).

Where art goes: **empty states and onboarding only.** The dot field (`DotMatrix`) fades in at the top of every page and is the only art a page with content carries. Empty states (`EmptyState`, `ArtEmpty`) get a `CardMedia` art strip; onboarding's right half is a full-bleed `ArtCanvas` with `animate`. No hero strips, no art across cards that hold content, nothing on a page that has data on it. Palettes by area: chat `sky`, study `lilac`, grades `meadow`, plan `dawn`, courses `paletteFor(course.id)`, onboarding cycles `sky → dawn → meadow`.

## Icons

**One family: Hugeicons stroke-rounded** (`@hugeicons/core-free-icons` 4.4.0 + `@hugeicons/react` 1.1.10, both MIT). Chosen by side-by-side comparison with Tabler (1.5), Lucide (1.5) and Phosphor Light against the references: the Conduit and Alpaca screens are drawn in Hugeicons (the circles-and-plus "Apps"/"Artifacts" glyph, the door "Logout", the scan-frame "Find", the bell with the low clapper, the waving hand, the rounded terminal square), and its 24 px grid with soft joins and 1.5 px strokes matches their weight. Tabler and Lucide are thinner-cornered and geometric; Phosphor Light is lighter and smaller in the box.

- Draw with `<Icon icon={icons.name} />`. Only `components/icons.ts` imports from the package; add a concept there before using a new glyph. Lucide and Phosphor are being removed screen by screen; don't add new uses.
- Size with `size-*` only: `size-4` in chrome, rows, menus, buttons, tabs and work-log rows; `size-3.5` in small buttons and chips; `size-3` inline and for disclosure chevrons in work rows; `size-4.5` for title-bar icon buttons; `size-5` for an action card's or empty state's leading glyph. Default (no class) is 16 px.
- Stroke comes from CSS: `--icon-stroke` 1.5, `--icon-stroke-small` 1.75 at 12–14 px. Never pass `strokeWidth`.
- Brand and provider logos stay as they are (`assets/providers/`, `components/provider-icon.tsx`).

| Concept (`icons.*`) | Hugeicons glyph | Replaces |
|---|---|---|
| chat | BubbleChat | Phosphor ChatsTeardrop, Lucide MessageSquare (views) |
| study | Cards01 | Phosphor Cards |
| grades | ChartLineData02 | Phosphor ChartLineUp |
| plan | Calendar03 | Phosphor CalendarDots, Lucide CalendarDays |
| courses | Mortarboard | Phosphor/Lucide GraduationCap |
| settings | Settings01 | Lucide Settings2 |
| search | Search01 | Lucide Search, Phosphor MagnifyingGlass |
| sidebar | SidebarLeft | Lucide PanelLeft |
| newChat | PencilEdit02 | Lucide SquarePen |
| notifications | Notification03 | — |
| welcome | WavingHand01 | — |
| apps | DashboardCircleAdd | Lucide LayoutGrid |
| command | Command | — |
| invite | UserAdd01 | — |
| signOut / signIn | Door01 / Login01 | Lucide LogIn |
| create / add | PlusSign | Lucide Plus |
| remove | MinusSign | Lucide Minus |
| find | SearchArea | — |
| research | Internet | — |
| webSearch | GlobalSearch | — |
| attach | Attachment01 | Lucide/Phosphor Paperclip |
| mic | Mic01 | — |
| send / arrowUp | ArrowUp02 | Lucide ArrowUp |
| stop | Stop | Lucide Square |
| model | AiBrain01 | Lucide Brain |
| ai | AiMagic | Phosphor Sparkle |
| step (tool summary, other tools) | Wrench01 | — |
| mode | SlidersHorizontal | Phosphor SlidersHorizontal |
| close | Cancel01 | Lucide X |
| check | Tick02 | Lucide Check, Phosphor Check |
| more | MoreHorizontal | Lucide Ellipsis |
| copy | Copy01 | Lucide Copy |
| edit | PencilEdit01 | Lucide Pencil, Phosphor PencilSimpleLine |
| rename | NoteEdit | Lucide PencilLine, Phosphor NotePencil |
| delete | Delete02 | Lucide Trash2 |
| retry | Refresh | Lucide RotateCw, Phosphor ArrowClockwise |
| undo | ArrowTurnBackward | Lucide RotateCcw, Phosphor ArrowCounterClockwise |
| reload / sync | Refresh01 / ArrowReloadHorizontal | — |
| download / upload | Download01 / Upload04 | Lucide Download |
| external | LinkSquare02 | Lucide ExternalLink, Phosphor ArrowSquareOut |
| pin / unpin | Pin / PinOff | Lucide Pin, PinOff, Phosphor PushPinSimple |
| play | Play | Lucide Play |
| view | View | Lucide Eye |
| quote | QuoteDown | Lucide Quote |
| reply | ArrowMoveDownRight | Lucide CornerDownRight |
| chevronRight / Left / Down / Up | ArrowRight01 / ArrowLeft01 / ArrowDown01 / ArrowUp01 | Lucide Chevron*, Phosphor Caret* |
| chevronsUpDown | UnfoldMore | Lucide ChevronsUpDown |
| arrowRight / Left / Down | ArrowRight02 / ArrowLeft02 / ArrowDown02 | Lucide/Phosphor Arrow*, Lucide CornerDownLeft |
| done | CheckmarkCircle02 | Lucide CircleCheck, Phosphor CheckCircle |
| failed | CancelCircle | Phosphor XCircle |
| warning | Alert02 | Lucide TriangleAlert, Phosphor Warning |
| error | AlertCircle | Lucide CircleAlert, Phosphor WarningCircle |
| info | InformationCircle | Lucide Info, Phosphor Info |
| help | HelpCircle | Lucide CircleHelp, Phosphor Question |
| blocked | Unavailable | Lucide CircleSlash |
| pending | DashedLineCircle | Phosphor CircleDashed |
| offline / disconnected | WifiDisconnected01 / PlugSocket | Lucide WifiOff / Unplug |
| locked | SquareLock01 | Phosphor Lock |
| time | Clock01 | — |
| trendUp / trendDown | ChartIncrease / ChartDecrease | Phosphor TrendUp / TrendDown |
| read | BookOpen01 | Phosphor BookOpenText |
| list / folderOpen | FolderOpen | Phosphor/Lucide FolderOpen |
| write | FileEdit | Lucide FilePen |
| terminal | ComputerTerminal01 | Lucide SquareTerminal, Phosphor TerminalWindow |
| task | Navigation03 | — |
| file / fileText | File01 / Note01 | Lucide File, FileBlank, FileText, Phosphor FileText |
| fileImage / fileCode / fileSheet / filePdf | Image01 / FileScript / Xls01 / Pdf01 | Lucide FileImage, FileCode, FileSpreadsheet, Phosphor FilePdf |
| fileVideo / fileAudio | Video01 / MusicNote01 | Lucide FileVideo, FileAudio |
| fileAttachment / fileMissing | FileAttachment / FileNotFound | Lucide FileWarning |
| folder / folderAdd | Folder01 / FolderAdd | Lucide FolderPlus |
| code | SourceCode | — |
| server / key | ServerStack01 / Key01 | Lucide Server, KeyRound |
| light / dark (theme) | Sun03 / Moon02 | Lucide Sun, Moon, Phosphor CircleHalf |
| deck | Layers01 | Phosphor Stack |
| quiz | CheckList | Phosphor Exam, ClipboardText |
| lecture / teacher | PresentationBarChart01 / Teacher | Lucide Presentation, Phosphor ChalkboardTeacher |
| goal / streak / insight | Target02 / Flash / Idea01 | Phosphor Target, Lightning |
| announcement / path / map / flag | Megaphone01 / Route01 / Maps / Flag01 | Phosphor Megaphone, Path, MapTrifold, Flag |
| stats | Analytics01 | Phosphor ChartBar |
| message | Message01 | Phosphor ChatText, ChatCenteredText, ChatTeardropText, ChatsCircle |
| sent / like / dislike | Sent / ThumbsUp / ThumbsDown | — |

File kinds (`features/viewer/FileIcon.tsx`) use the `file*` concepts. Work steps in chat use `read`, `list`, `search`, `write`, `terminal`, `step`.

## Screens

Each blueprint: what the references fix, then the layout. Pages sit in the panel's main column with `px-8` sides and a centred column (`max-w-(--page-max-width)` unless noted), starting `pt-10` under the title bar so the dot matrix shows above the first block.

### Chat — welcome (empty conversation)

a163, a6e6, 8386; Claude.ai, ChatGPT and T3 Code new chats. Compact and calm: the mark, the question and the composer are one group a little above centre (the space above grows 2, below 3, so it sits about two fifths down): `BrandMark` (20 px, Phaethon blue), "Where should we begin?" (`text-2xl`, weight 400, `tracking-heading`, 12 px below the mark), the composer (20 px below, `max-w-(--chat-max-width)`, unchanged). 12 px under it, one centred row of starter chips that wraps on narrow widths (8 px gap): `Button variant="outline"`, `h-8`, pill, `text-sm` weight 400, a leading `size-4` icon in the muted icon colour, the label alone. A study space's three: Teach me, Quiz me, Plan my week; any other: Create, Find, Summarize; each fills the composer with a starter and never sends. The row ends with one quieter chip, `ghost-muted` ("Add files to School"), that brings files into the space and spins while it works. Nothing else on the screen: no cards, nothing pinned to the bottom, no art behind the hero; the dot field only.

### Chat — timeline

b583, f510, fd96, 91b5, 8a83, 7cad, d706.

- Column `max-w-(--chat-max-width)`, centred, no scrollbar. The **history rail** (`components/HistoryRail.tsx`, after T3 Code's minimap) stands in the left gutter: one short strip per message you sent, dark for the turns on screen; hovering previews a turn (your words and the reply's last words), clicking jumps to it, arrows above and below step through turns. It shows only when the gutter is at least 48 px, else on hover.
- **Scrolling** (`features/chat/timeline-scroll.ts`, decisions in `lib/scroll.ts`; after T3 Code, assistant-ui, use-stick-to-bottom and LibreChat). A conversation opens at its end, or at the place it was left, on its first frame: no scroll animation, ever, on opening. The place is a message and its offset from the top, not a pixel position, so it survives content changing height. At the end, the browser's scroll anchoring holds it: a 1 px marker after the messages is the box's only anchor candidate (messages are `overflow-anchor: none`), so a streaming reply, a diagram drawn or older turns mounting never move the end, not even for a frame. A ResizeObserver backs that up and holds a reader's place when they are not at the end. Only the reader lets go of the end: a wheel or key up, or a scroll up while the content kept its height (a clamp from content shrinking is not one). Scrolling down to within 48 px pins it again; sending a message goes to the end. "Latest" and the history rail glide for up to a screen and a half and jump further (always jump under reduced motion); a rail jump holds its turn 24 px below the top while the conversation settles.
- **Long conversations** mount in steps: 60 messages or more open with the newest 24 (or the 24 around the place they were left at), then 40 more on each side per frame in a transition until all are there, so opening one never stalls; a hidden page pauses until shown. Every message ends up mounted (copy, the rail, keyboard focus and find all see the whole conversation); a rail jump or "Latest" mounts the rest at once first. Messages are memoized, so a streaming reply renders only itself. Drawn diagrams and compiled LaTeX are kept for the window's life, so a conversation opened again lays them out at their size at once.
- Hidden pages (`app/Shell.tsx` `Pane`) are out of the flow behind the shown one with `content-visibility: hidden` rather than `display: none`: the browser keeps their layout and styles, so switching back to a long conversation costs no relayout and finds its scroll position untouched. Nothing inherited (`inert`, `visibility`, `pointer-events`) is toggled on them; that would restyle the whole page.
- User turn: right-aligned ink bubble (`bg-message text-message-foreground`, `rounded-2xl`, `px-3.5 py-2`, `text-sm`, at most three quarters of the column), attachments as `h-7 rounded-lg` chips above it. Its time, copy and edit sit under the bubble on the right, on hover. Long user text clamps at 12 lines with "Show more".
- Files named in a reply read like links (`FileChip variant="inline"`: the file's glyph, `text-primary`, an underline that darkens on hover; no box, no background, no path tooltip). A citation is the same in `text-muted-foreground` at 0.92 em; hovering it opens the quote check card. The path lives in the right-click menu and the viewer's header.
- Assistant turn: starts with the `ThoughtToggle` ("Thinking…" with spinner while reasoning, "Thought 12s" after); open, it shows a dot `StepList` in plain words. Then the prose (`.markdown`, 14/22). Then message actions as `ghost-muted` icon buttons (copy, retry): flat, never outlined.
- Work (tools): one quiet `ToolSummary` line per turn (`text-sm text-muted-foreground`, a 16 px subtle glyph, "Read 2 files, edited 1, ran a command", duration in `text-xs` on the right). While running: the spinner, the live step in plain words with `text-shimmer` ("Running git status" for a command), elapsed time; after 8 s a reassuring second line. Open: a `WorkLogList` after T3 Code's work log (`components/ui/work-log.tsx`): one 28 px line per step, a 16 px glyph in `text-subtle-foreground`, the step in `text-sm text-muted-foreground`, file chips at 24 px; no rail, no tag chips. A command's line is the command itself (`font-mono text-xs`, cut to one line; the coding agents record it without the shell they wrapped it in, paths as in the space) with a chevron; one click opens what it printed (scrolls past 20 lines, or "No output"), with the whole command above it when the line was cut or spans several lines. A failed command's glyph turns red; no exit codes, no copy buttons. What a tool *read* never enters the conversation. Chosen over the old "Ran a command" → command → output (two clicks for the command, three for output): T3's pattern shows the one thing worth reading at a glance and keeps output one click away. Other tools' technical labels and raw output stay behind Settings › Show technical details. A command saved before its line was kept reads "Ran a command".
- Sources used: a `Card variant="well"` with a header row ("3 sources used ⌄"), rows with the file glyph, "Show all" (fd96).
- Approval card (d706 left): `Card` with `p-3`; header row: blue `done` icon + "Draft is ready" in `text-primary text-base`; a `well` box with the draft and small rect buttons (Edit = ink, View changes = outline); under it `KeyActions` with "Y Accept" and "N Reject" (keys bound while the card is the newest pending one). Denied, accepted and expired states replace the bar with one muted line and an icon.
- Question card (d706 right): header "Needs your answer" with the blue info icon and "1 of 3" pager (chevrons); each question in a hairline-separated block (question `text-base`, the chosen answer muted below); a closing row with the spinner and "Preparing your draft…" while the agent continues.
- Limits and errors above the composer (fd96): a `well` card with an icon line, one sentence, Close + an ink action with its keys.

### Composer and model picker

a6e6, 95ba, a163, 8386.

- `Card` (`rounded-card`, hairline), textarea `text-base` with the placeholder "Ask anything…" (`text-placeholder`), min 3 lines. The box takes focus when its chat is on screen and nothing else has it, and a key typed anywhere else on the page (not in a field, dialog or menu) lands in it. Toolbar row (`gap-1 px-2.5 pb-2.5`): attach as a `ghost-muted` `icon-xs` button (quiet; it should not draw the eye); the teaching mode as the same quiet icon button (lightbulb) that becomes a `ghost xs` button in `text-primary` with the mode's name only while a mode other than Normal is on; then on the right the model picker (provider logo, model name, chevron; `h-7`), reasoning as the three-bar glyph alone in an `icon-xs`-sized trigger with the level's name in its tooltip (never as text in the bar), and send: a round `size-7` button, ink when there's text, `bg-primary/30` disabled tint when empty (a6e6's pale blue circle), Stop (square) while running.
- Model picker popover (8386): `rounded-xl` popover, section label "Models", rows with the provider logo, name, and a 10-segment speed/strength meter in the provider's brand tint; the selected row has a check. Effort is a segmented control at the bottom.

### Study

- **Overview** (2c35, 0922, b72b): page title row ("Study" is in the tab, so the row shows "5 cards due" as a hero `Card` with `CardMedia` art strip (`lilac`, `weave`), title, one line "About 2 minutes · 5 new · 4-day streak", and an ink "Review due cards" pill). Below, a `StatGrid` (due, reviewed this week, mastery, streak). Then **Decks** and **Quizzes**, each a 2-column grid of compact cards (`StudyCard`, about 64 px: `rounded-card` hairline, a 36 px `well` glyph tile, the name in `text-sm font-medium`, one muted meta line; the whole card is one button, the "⋯" menu beside it on hover or focus). A card never repeats anything: no title or subtitle block under it, no course name on it, no first-question preview. The name drops a leading course code or course name when it is the card's own course ("MTH 214 Test 1 practice" reads "Test 1 practice"; `lib/shelf.ts`, the code from `study_sources`). The meta line is only what differs per card: its state first (a deck's "2 due" in `text-primary`, else "4 new", else "80% known"; a quiz's "3 answered" in `text-primary`, else its last score, amber under 60%), then its size ("6 cards", "15 questions"). A space with one course shows one plain grid; a space with several groups each section by course, the course's name once as a muted `text-sm` label over its cards (courses by name, then "Your own cards" or "Other quizzes"). Two cards in a group whose names read the same also show their first card or question on a third line, the only time it appears.
- **Make a quiz** (dc3a, 9091): a dialog `rounded-panel` in three steps (What: course, test or topics, what the test covers; Questions: size, difficulty, kinds, model; Make: the stages). The run itself lives in `features/study/jobs.ts`, not in the dialog: closing the dialog never stops it ("Close, keep making it"), Stop asks the core to stop, and pressing Make again for the same course, test and kind joins the run under way instead of starting a second one. Study's overview lists every run in the space under **Making now** (`MakingRow`: glyph, name, a thin bar, the stage in plain words, elapsed time, Stop) and reloads when one ends; a run nobody is watching says so with a toast ("Your quiz is ready · Open").
- **From chat**: a `phaethon-study` card whose plan says enough (a course, and a test the course has described or topics) makes it on one click, with its progress under the card; it opens the dialog only at the step that needs an answer (what an unmapped test covers). When it is done the card's button opens the quiz or deck.
- **Quiz taking** (d706 right, 8c35): centred column; header with "Question 3 of 10", a thin progress bar in ink, close; question `text-xl`; answers as large `interactive` cards with a keycap (A–D) each; Check as an ink pill; feedback slides in under the answer (success or destructive tint, explanation). Keys: 1–4 / A–D, Enter.
- **Results** (c06d): a centred `Card` "You're all set"-style: art strip, score as `text-3xl`, a `well` list with blue tick discs per outcome, buttons "Review mistakes" (ink) and "Done" (outline).

### Grades

0922, 91b5, b583. Page `max-w-(--page-wide-max-width)`.

- **Home (several courses):** title row with "Grades" and the term line on the left and the term GPA on the right (`text-3xl` with "/ 4.0", unweighted mean of each course's letter on the scale from Settings › General › Grades: the standard 4.0 points, or the person's own points per letter). One page, no tabs: a `StatTile` per course with its percent, letter and delta, then the four attention panels (Due soon, Missing or late, Recently graded, Worth the most). A tile opens its course; a line in an attention panel opens its course scrolled to that assignment's row, which takes focus and is tinted for a moment. Under a line, its course is named only when the panel mixes courses. Every course's table (sortable, filterable, collapsible) is a quiet `ghost-muted` "All grades ›" button in the title row beside the GPA, never a full-width track; it opens as its own page with "← All courses" above it. Moving between the home, a course and All grades lands keyboard focus on the new page's `h1`, or back on the tile of the course just left. Nothing heavy sits at the bottom of the home.
- **Course names** are shown short everywhere on the page (`features/courses/lib/names.ts` `shortCourseName`): a leading term code ("XX99: ") and a trailing section or CRN (": 1234", "(All Sections)") are dropped, and a name sent in capitals is given ordinary case, keeping course codes, roman numerals and common acronyms.
- **One course:** a quiet "← All courses" `ghost-muted` button in its own row *above* the card, never inside it. The card: the course name as `h1`, the graded count and freshness, the current grade `text-3xl` with its letter and delta; a `StatGrid` of four tiles (graded, still open, strongest, weakest). Then the charts (breakdown `StackedBar` + `BarLegend`, trend with a `Tabs` range), the attention panels for that course, then its table.
- **Assignment table:** columns Assignment (title, with its category after it in muted `text-xs`), Due, Score, Weight; rows `h-9`; status as `sm` badges (Missing, Late, Excused, New); open items take a trial score inline (what-if) and the footer shows the projected total. Category chips with weight and standing sit above the table.

### Plan

7274, dc42, e0fb. A week/agenda layout: left a narrow column (`w-64`) of filters as sidebar rows with counts (e0fb's channels list with status dots); right the agenda: day headers (`text-sm font-medium`, date muted), items as rows with a time column, title, course tag and a status dot; drag handles on hover. Today's card at the top in `CardMedia` (`dawn`). Empty day: a quiet muted line. Planning an item opens a side sheet (`rounded-panel`, like 7274's right panel) with fields and an ink Save.

### Courses

7274, 02a1, 8bdf, dca9. A list/detail layout inside the page: left a 280 px pane ("Courses" title with the ink `+`, search field, a list of course sites as folders holding their courses with indentation, a count footer: `--footer-height` like the sidebar's footer so their hairlines meet, the count left-aligned with the list in `text-xs text-subtle-foreground tabular-nums`); right the detail with a breadcrumb row (pane toggle, `folder` glyph, chevrons; the site crumb gives way before the course's name) and actions (Import, `…`), then the course as one page with no tab track: a card with the facts the breadcrumb doesn't show (sign-in state, term, last update; never the course's name again) and its numbers, then its content ("Content 14" with a small All · Files · Pages kind picker and a filter) in grouped lists, then what the last import couldn't bring in. The course's settings (what this space sees, part by part) open from the `…` menu's "Course settings" as a dialog; a course the space can't see shows one line and that button. Never put a full-width `Tabs` track under a page or detail header to switch its sections: stack them or move the rare ones into the `…` menu. `Tabs` are for small value pickers (1W · 1M · All, Quiz · Cards), and left-pane tabs only belong there when they switch the left list itself. Connect/import flows use dca9's marketplace layout: centred title, search field, an `ArtCanvas` banner with prompt pills, then "Featured" two-column rows (logo tile, name, one line, a `+` outline icon button or a check). Sync status uses tint badges ("Synced" info, "Pending" warning) as in 7274.

- **The list's tree** (`features/courses/components/CourseTree.tsx`). A site row (32 px: chevron, the site's mark, its name in `font-medium`, the sign-in dot, `…` on hover), then its courses on a 1 px `--border` guide line. Two tokens set the geometry: rows start `--tree-pad` (8) in and the chevron and every course icon sit in a `--tree-icon` (16) column, so the line runs exactly under the chevron's centre (pad + icon / 2; measured in the mock: both at x 272) from the site row's bottom to the last child, and the courses start right of the chevron's column, their icons under the site's mark. Course rows are the sidebar's rows (`sidebarMenuButtonVariants`: 28 px, `text-sm`, the 16 px icon column, `bg-row-selected` when open) holding the course's short name (`lib/course-name.ts` `shortCourseName`: the term prefix and trailing section or CRN dropped, names that arrive in capitals set in title case with numerals and acronyms kept, "XX99: INTRO PLACEHOLDER STUDIES: 1234" → "Intro Placeholder Studies"), sorted by it; no code on the row: the raw name and code are the row's tooltip.
- Courses the space can't see never compete with the ones it can: they fold into one last row under the site, "8 hidden" (`tone="muted"`, a chevron in the icon column), shut by default and remembered per site (`phaethon.courses.hiddenOpen`). Open, they list under it compact (24 px, `text-xs`, `text-subtle-foreground`, no icon, no per-row "Hidden"), each with an eye on hover that shows the course in this space again. A search shows the hidden courses it finds.

### Settings

e0fb, dc3a, 9e25, 8bdf, laid out like a desktop app's preferences (dense and plain, no card per setting). Left column (`w-64`) of section rows with icons and group labels (General, Appearance, Agents, Providers, Spaces, About), status dots or a usage badge on the right where useful. Right: a centred `max-w-(--settings-max-width)` column (`pt-8`, groups `gap-6`) built only from `features/settings/ui.tsx`. A section is a stack of `SettingsGroup`s: a small label (`text-xs text-subtle-foreground`, sentence case, no icon; omitted when the section title already says it) with an optional `ghost` `xs` action on its right ("New space", "Add provider"), above one bordered list (`rounded-card border bg-card divide-y`), and an optional one-line footnote under it. That list is the only container in settings: related settings share a group, and a lone setting joins a sensible group instead of getting its own box (General is the folder, technical details and grade points in one group, then the shortcuts). Each setting is a `Row` (`min-h-10 px-3 py-2`): label `text-sm` left, control right, one line; a `text-xs text-muted-foreground` description under the label only under the Copy rule. `SwitchRow` is a row whose control is a `Switch` (the label flips it; `pending` holds the new state). `Field` (label above a full-width control, hint or error under it) is for keys and addresses. Paths are mono `text-xs`, start-truncated, with the copy button inline; text inputs in rows are `size="sm"` and `w-64`; buttons in rows are `xs`. Keyboard shortcuts are 32 px rows with the small `Kbd` chips. `EmptyRow` is a list's only line when it's empty. Providers and Coding agents are each one group: a 40 px row per provider or agent (logo, name, the model or account in use, its state, a chevron) that opens its key, model, install command or accounts and usage under it as `RowDetail` (its own rows under a hairline, indented to the name), one at a time; agents that aren't supported yet are quiet rows at the end. Appearance's three theme previews sit inside one group. Dark mode reads as 9e25: lists at `--card`, rows with brand glyphs, blue switches.

**Which space sees which course** (Settings › Courses, `features/courses/components/SpaceAccess.tsx`) is a list, never a matrix: it has to hold 100+ spaces and 100+ courses. One 44 px row per course: its readable name (`shortCourseName` in `lib/space-access.ts`: no leading term, course code or trailing section/CRN, all-capitals names title-cased; the raw name is the tooltip when they differ), then the spaces that see it as outline chips (space dot + name; a dashed chip sees only some parts), at most three, the third becoming "+N" with the rest in a tooltip, and a chevron. The chips are the trigger of `AccessPicker`: a combobox popup with a search field (once there are more than six), every space with its dot, a tick for "every part" and a muted "Some parts"; picking a blank or partial space gives it every part, picking a ticked one takes it away, each saved at once (optimistic, reverted with a toast on failure). Courses group under a quiet school label only when they come from more than one school; a search field tops the list past eight courses; courses no space sees fold into a quiet "N not in any space" row at the end (open while searching), their rows reading "+ Add to a space"; past 30 rows a "Show N more" row. The inverse is the same picker, not a second matrix: a space with study tools shows a "Courses · Sees 4 of 20" row with a Choose button under Study tools in Settings › Spaces (`SpaceCourses.tsx`).

### Onboarding

3940, e3e4, 2c35, d1d3, c06d, d922. Full window, no app frame chrome: left half on `--background` with the mark at the top, a centred form column (`max-w-sm`): title `text-2xl` weight 500, one line muted, the step's controls, a full-width ink button; step dots at the top (blue active bar, grey dots). Right half: an `ArtCanvas` filling the half edge to edge (hairline on its left, `animate`) holding a live, scaled preview of what the step sets up (a sidebar with spaces, a provider card). The finish step is c06d's "You're all set" card: a `well` list of what was set up with blue tick discs, Explore (ink) and Close (outline). Each step's art palette differs (`sky → dawn → meadow`).

### Viewer

02a1, 8bdf. The file viewer is a resizable panel at the right of the main column (hairline on its left edge). Every file opened stays open as a tab: the 48 px header is a tab strip drawn exactly like the title bar's (`components/ui/page-tabs.tsx`; "Open files": file glyph, middle-truncated name, ×; the one on show joins the toolbar below; middle-click closes, right-click offers Close, Close others, Close all, Copy path; arrows move between tabs) with one × at the end that shuts them all. Opening a file already open shows its tab; a new one opens after the one on show; past 12 the oldest not on show closes. Closing the one on show shows its neighbour. Under the strip, a 40 px toolbar for the file on show: its glyph, its folder (muted, start-truncated) and name, its size, and open externally, show in folder, copy path. Each tab keeps its own place while another is shown. The body scrolls with the document centred; a footer row for counts ("63 words · 375 characters") and Cancel/Save when editing. A side info panel (8bdf's "Skills info") is a 280 px column of label/value rows.

### Dialogs, menus, empty states

- Dialogs (9091, 8c35): `rounded-panel`, `p-6`, title `text-lg` + description; content in cards; footer with Cancel (outline) and the action (ink or accent), or one full-width ink button.
- Menus (8386): `rounded-xl`, header block allowed (avatar, name, email), rows `h-8` with icons, a tinted "New" badge on the right.
- Card and row icons hang free: never a bordered tile around a glyph or a logo. A card leads with its icon at `size-5` (a brand mark at `size-6`) straight on the card (settings has no card headers); a list row's glyph is `text-muted-foreground` in a `size-6` slot with no border or background.
- Course sites show their own mark (`components/site-mark.tsx`): the school's icon when the site serves one (the core fetches its apple-touch-icon or favicon once a week), else the Canvas or Moodle brand mark, else a plain monogram (D2L, Bb). It leads the site's row in Courses, the course sites list in Settings, the connect dialog and the import dialog.
- Empty states: an `ArtTile` or `CardMedia` strip, one line title (`text-base font-medium`), one line muted, one ink or outline action. Never a lone grey icon in a void. Use `EmptyState` from `components/errors.tsx` (`compact` for an empty inside a card).
- Copy: a caption exists only when the user cannot act without it: a consequence under a destructive action, a scope or format fact they cannot see, what a blank state means and the next step, units on a bare value. Cut captions that restate the title, the field or the button; cut sentences that pre-empt a worry the user did not have ("never sees your password", "what's here stays", "you can change this later") and explanations of why a thing is the way it is. A dialog titled by its action ("New space") needs no description. Keep what survives to one sentence.

## State and feedback

- **Loading**: skeletons match the layout they stand in for and appear after 150 ms (`useDelayed`). No full-screen spinner; the shell paints immediately.
- **Buttons**: `<Button pending>` keeps its width and shows the spinner; `<Button success>` shows a tick. `AsyncButton` and `useAsyncAction` run pending → a tick for 1.2 s, or a shake plus an error toast.
- **Switches**: `ToggleRow pending` keeps the new state while saving and reverts with a toast on failure.
- **Agent work**: the `ThoughtToggle` spinner, the live step with `text-shimmer`, elapsed time; never a silent wait.
- **Toasts** (`components/toast.tsx`): bottom right, at most three, for things the user isn't looking at. The icon pops in and a hairline counts down (paused on hover). `toast.promise` turns a spinner into the result.
- **Copy**: the glyph swaps for a tick, or a toast says "Copied" when the copy came from a menu.
- **Errors**: say what happened and what to do next, sized to the surface.

| Level | Where | Look |
|---|---|---|
| Field | under the input | `text-destructive` line with an icon; the input border turns destructive |
| Row | inside the row | muted "Couldn't load" + inline Retry; the row keeps its height |
| Surface | top of the panel, or where a reply failed | `SurfaceError`: tinted alert, one-line title, message clamped to 2 lines, actions on the right |
| Connection | above the composer | "Reconnecting to Phaethon's core…" with the spinner |
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

- **Right-click** works everywhere it makes sense (`components/ui/context-menu.tsx`). Messages: copy, copy as Markdown, edit, retry. Code blocks: copy code, copy as Markdown. Links: open, copy. Files: open, open in the default app, show in folder, copy path. Selected text and text fields fall through to the system menu from `src/desktop/main.ts`.
- **File references** are `FileChip`s (`components/file-chip.tsx`); clicking opens the in-app viewer. Web and mail links open in the browser (`features/chat/lib/links.ts`).
- **Composer autocomplete**: `@` lists the space's files, `/` at a line start lists commands. The textarea keeps focus: arrows move, Enter or Tab picks, Esc dismisses.
- **Keys**: ⌘K search, ⌘N new chat, ⌘\ or ⌘B sidebar, ⌘, settings, ⌘1–9 spaces, ⌥⌘1–5 views, Y/N on the newest approval card.

## Checks

`pnpm typecheck`, `pnpm test`, `pnpm test:ui` (Playwright in `e2e/*.spec.ts` against the real core with a scripted model; `desktop.spec.ts` needs a display). Visual: `pnpm exec vite --port <free port> --strictPort`, then `#mock` for the app on the fake core and `#gallery` for the primitives; screenshot light and dark with Playwright and compare side by side with the screen's references before calling it done. `node scripts/capture.mjs out.png` captures the real Electron window.
