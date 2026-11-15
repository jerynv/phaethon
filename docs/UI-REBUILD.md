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
| `--row-selected` | `oklch(95.2% 0 0)` | `oklch(100% 0 0 / 8%)` | the selected sidebar row, the selected pill tab |
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

Art palettes are tokens too (`--art-{sky,dawn,meadow,lilac,ember}-{0…4}`): a base and four mesh colours each, soft pastel (L 62–95 %, C ≤ 0.16). They are the same in both themes; `--art-veil` lays a 38 % panel-coloured veil over art in dark mode.

### Radius

`--radius` is 10 px. Steps: `rounded-xs` 4, `sm` 6, `md` 8, `lg` 10, `xl` 14, `2xl` 16, `3xl` 20, `4xl` 24, `rounded-control` 10. Semantic: `rounded-card` (16, every card), `rounded-panel` (20, the app panel, hero and art cards), `rounded-full` (text buttons, pills, the thought toggle). Inputs and the search field are `rounded-lg`; menu rows `rounded-sm`; tab pills `rounded-md` inside a `rounded-lg` track.

### Spacing

The 4 px grid (Tailwind's scale). Card padding is `p-5` (20), compact cards `p-4`; card-to-card gaps `gap-3` (12) in a grid, `gap-4` in a stack; page sections `gap-8` to `gap-10`; page side padding `px-8` (`px-6` under `@3xl`). Rows are 28 px (`h-7`); legend and step rows 28–32; toggle rows `py-3`. The app panel is inset `--frame-inset` (8 px) from the window.

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

- Hairlines carry structure: `border` is 1 px `--border`. Cards, the panel, the composer, inputs and tables all use it.
- `shadow-card`: `0 1px 2px` at 5 % (30 % in dark). Only lifts a card off a grey well; never a drop shadow.
- `shadow-raised`: the white pill in a tab or segmented track (card shadow plus a 0.5 px `--border-strong` ring).
- `shadow-popup`: menus, popovers, dialogs (soft 40 px drop plus a hairline ring).
- No other shadows, glows or gradients on chrome.

### Geometry and layers

`--titlebar-height` 48, `--sidebar-width` 248 (user-resizable 216–420), `--chat-max-width` 736, `--page-max-width` 768, `--page-wide-max-width` 1024, `--settings-max-width` 672, `--search-width` 320, `--traffic-light-inset` 76 (the only place that number appears). Layers: `z-(--z-sheet)` < `--z-dialog` < `--z-popup` < `--z-tooltip` < `--z-toast`. Responsive rules use container queries on the surface (`@container/header`, `@container/composer`, `@container/page`), not viewport breakpoints.

### Motion

- Durations 120–240 ms; springs (`stiffness 420–520, damping 32–42`) for layout, `--ease-out-soft` for CSS. Everything interruptible; nothing animates per keystroke.
- Pages fade and lift 4 px in. Lists grow rows in and fold them away. Tabs and segmented pills glide. Steps fade up 2 px as they arrive. Stacked bars grow from the left once. Art drifts only where `animate` is set (onboarding, the welcome hero), over 28 s, and stops under reduced motion.
- `prefers-reduced-motion` turns animation off globally (index.css) and `useReducedMotion()` skips springs.

## App frame

After a163, 9334, b72b, dca9, 3940 (Alpaca) and 7274, 8bdf, 02a1 (Conduit Agent Space).

```
┌ canvas (--canvas), padding --frame-inset ─────────────────────────────────────────────┐
│ ┌ panel: rounded-panel, border, bg-background, shadow-card ─────────────────────────┐ │
│ │ ● ● ●  P Phaethon   ▯ ✎ │ [💬 Chat][Study][Grades][Plan][Courses] | title  [ 🔍 Search  ⌘K ]  actions │
│ │─────────────────────────┼───────────────────────────────────────────────────────────│ │
│ │ sidebar (bg-background) │ main: page, faint dot matrix fading from the top          │ │
│ │                         │                                                           │ │
│ └─────────────────────────┴───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- The whole app is one white panel on the grey canvas. The sidebar and main column sit side by side in it, split by a hairline; both start with a 48 px row with a bottom hairline, so the title bar reads as one band.
- macOS traffic lights sit in the panel's top-left (`trafficLightPosition` 22, 26 in `src/desktop/main.ts`), inside the sidebar's top row. With the sidebar hidden the header takes `pl-(--traffic-light-inset)`.
- The native window background is the canvas colour so the first frame matches.
- `DotMatrix` sits behind the top of every page (absolute, `--dot-matrix`, fading by 96 px). Pages keep a transparent background so it shows.

### Title bar (`app/Header.tsx`)

- Three columns: `[minmax(0,1fr) auto minmax(0,1fr)]`.
  - Left: Show-sidebar (only when hidden), the view tabs as `TabsList variant="pill"` with an icon and label each (labels hide under `@5xl/header`), then the page's title slot after a hairline divider (muted; a `font-medium` part reads as the current item). A space without study tools shows its avatar and name instead of tabs.
  - Centre: the search field, `w-(--search-width)`, `bg-well`, hairline, magnifier, "Search", the ⌘K keys; it opens the command palette. Under `@3xl/header` it collapses to the magnifier.
  - Right: the page's actions slot, right-aligned (`Button size="sm"` pills, `icon-sm` ghost icons).
- The tablist keeps its accessible name "Views"; tabs keep their labels as names even when the text is hidden.
- Pages render `<Header title actions />`; it portals into the bar only while the page is visible. Don't repeat the view name as the title; use it for context (a conversation's title, "Quiz / Sets and functions").

### Sidebar (`app/Sidebar.tsx`, `components/ui/sidebar.tsx`)

After 3940, a163, 9334 (rows, section labels, recents) and e0fb (status dots).

- Top row (48 px, hairline below): the mark (`BrandMark`, 16 px) and, off macOS, "Phaethon"; Hide-sidebar and New-chat icon buttons (`size-8`, `rounded-lg`) on the right.
- Then, when needed, a short list of fixed rows with icons (Search lives only in the title bar), a section label "Spaces" (`text-xs text-subtle-foreground`, sentence case, `h-7`, `mt-4`; refs: "Workspace", "Recents"), each space as a row with its avatar, and its conversations under it as the "recents" list: 28 px rows, `text-sm`, `rounded-md`, hover `bg-accent`, selected `bg-row-selected`. Status sits in a 16 px gutter on the left: a blue dot for a new reply, the spinner arc for replying, an amber dot for needs-you, a red mark for failed, a thin pin for pinned (the references' dot column).
- Icons in rows are `size-4`, `text-muted-foreground`; trailing text (time, count, shortcut) `text-2xs text-subtle-foreground tabular-nums`, giving way to hover actions.
- Footer (hairline above): Settings row with its keys; the update pill above it.
- Resize rail, offcanvas collapse, keyboard row navigation, right-click menus: unchanged behaviour.

## Primitives

All in `components/ui/` unless noted. `#gallery` renders each.

| Primitive | Import | Rules |
|---|---|---|
| Button | `@/components/ui/button` | `default` = ink pill; `outline` = white pill with hairline; `accent` = blue pill (rare); `secondary` = grey; `ghost`, `ghost-muted`, `destructive`, `destructive-outline`. `shape` is `pill` for text sizes, `rect` (`rounded-control`) for icon, `xs`, `compact`, `micro` sizes; pass `shape="rect"` for a toolbar or in-card action ("Save", "Edit message"). `pending` and `success` keep their width. One `default` button per surface. |
| Card | `@/components/ui/card` | `Card` (`default`, `well`, `ghost`, `interactive`), `CardMedia` (art across the top), `CardHeader`, `CardTitle`, `CardDescription`, `CardAction` (top-right badge or button), `CardContent`, `CardFooter` (grey, hairline above, actions right). 16 px radius, `p-5`. |
| Tabs | `@/components/ui/tabs` | `TabsList variant`: `segmented` (grey track, white raised pill; default), `pill` (title bar), `underline` (text over a hairline, ink bar). `size="sm"` for dense toolbars. Use when the choice swaps a panel. |
| Segmented control | `@/components/ui/segmented-control` | `SegmentedControl` + `SegmentedControlItem` for choosing a value (range, mode, filter). `track` (pill glides with a spring) or `outline` (cells split by hairlines, chosen cell turns ink and medium). Always exactly one value. |
| Switch | `@/components/ui/switch` | Blue when on, `--input` when off. |
| Toggle row | `@/components/ui/toggle-row` | `ToggleRow title description checked onCheckedChange icon? pending?`. The row is the label. Stack in `divide-y` inside a Card. |
| Stat tile | `@/components/ui/stat-tile` | `StatTile label value unit? hint? delta? tone?` on `bg-well` with a soft hairline, label above a 24 px number. `StatGrid` lays them two across in a card, four across on a wide page. |
| Stacked bar + legend | `@/components/ui/stacked-bar` | `StackedBar segments` (12 px tall, 2 px gaps, `--chart-*` colours, grows in) and `BarLegend segments` (dot, label, value, "(percent)"), `percentOf`, `chartColor`. |
| Keycap and keyed actions | `@/components/ui/kbd`, `@/components/ui/key-actions` | `Kbd variant="keycap"` is the 24 px grey key. `KeyActions` + `KeyAction shortcut="Y"` is the split bar under an approval card; the card binds the keys. |
| Steps | `@/components/ui/step-list` | `ThoughtToggle state label open onOpenChange` (the "Thinking… / Thought 12s" pill: spinner, dark tick disc, or failed mark; chevron right when closed, down when open). `StepList variant="dot"|"icon" open` with `Step state icon? tag? meta? detail?` on a 1 px rail. `ToolSummary summary duration running open` is the "18 tools, edited 5 files, ran 2 commands ⌄ … 6m 12s" line. `formatDuration`. |
| Spinner | `@/components/ui/spinner` | A faint ring with a turning arc. |
| Art | `@/components/art` | See Art. |
| Brand mark | `@/components/brand-mark` | `BrandMark` in `currentColor`. |
| Icon | `@/components/icon`, `@/components/icons` | See Icons. |

Existing primitives (menu, dialog, alert-dialog, popover, select, combobox, autocomplete, command, tooltip, input, textarea, checkbox, radio-group, badge, alert, empty, skeleton, scroll-area, sidebar, toast) keep their API; they take the new tokens automatically. Menus and popovers are `rounded-xl`, `shadow-popup`, rows `rounded-sm h-7`, icons `size-4 text-muted-foreground` (ref 8386: Settings / Language / Docs / Apps / Logout with a "New" tint badge).

## Art

`components/art.tsx`, all seeded (same seed, same picture), all from `--art-*` tokens:

- `ArtCanvas palette seed grain weave animate`: eight layered radial gradients (four big soft fields, four brighter cores) over the palette base, film grain from SVG `feTurbulence` in soft light, optional woven 3 px grid (`art-weave`, the halftone look of 2c35 and d1d3), the dark-mode veil. Fills its box; put it in `CardMedia` or `absolute inset-0`.
- `ArtFrame palette seed`: a card set into an art panel; art shows on the top and left edges and the card runs off the bottom-right (b583, f510).
- `ArtTile`: a small rounded thumbnail for list leaders and onboarding steps (5ec7, a163's "Connect your channel").
- `DotMatrix seed`: the faint 2 px dot field on a 7 px grid that fades out at the top of pages (every Alpaca screen, 7cad, 9e25).
- `paletteFor(seed)` picks a palette for things that each want their own art (a course, a deck).

Where art goes: the welcome hero background is plain (dots only), its secondary card uses an `ArtTile`; onboarding steps each get a full-bleed `ArtCanvas` panel (3940's right half, e3e4's right half) and `animate`; empty states get a `CardMedia` art strip or an `ArtTile`; Study's hero card and Grades' term card get `CardMedia`. Never more than one large art surface on a screen. Palettes by area: chat `sky`, study `lilac`, grades `meadow`, plan `dawn`, courses `paletteFor(course.id)`, onboarding cycles `sky → dawn → meadow`.

## Icons

**One family: Hugeicons stroke-rounded** (`@hugeicons/core-free-icons` 4.4.0 + `@hugeicons/react` 1.1.10, both MIT). Chosen by side-by-side comparison with Tabler (1.5), Lucide (1.5) and Phosphor Light against the references: the Conduit and Alpaca screens are drawn in Hugeicons (the circles-and-plus "Apps"/"Artifacts" glyph, the door "Logout", the scan-frame "Find", the bell with the low clapper, the waving hand, the rounded terminal square), and its 24 px grid with soft joins and 1.5 px strokes matches their weight. Tabler and Lucide are thinner-cornered and geometric; Phosphor Light is lighter and smaller in the box.

- Draw with `<Icon icon={icons.name} />`. Only `components/icons.ts` imports from the package; add a concept there before using a new glyph. Lucide and Phosphor are being removed screen by screen; don't add new uses.
- Size with `size-*` only: `size-4` in chrome, rows, menus and buttons; `size-3.5` in small buttons and chips; `size-3` inline; `size-4.5` for title-bar and tool-row icons; `size-5` for an action card's or empty state's leading glyph. Default (no class) is 16 px.
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
| ai / step | AiMagic | Phosphor Sparkle |
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

a163, a6e6, 8386. A centred column at about 38 % of the height: `BrandMark` (24 px, foreground), "Where should we begin?" (`text-2xl`, weight 400, `tracking-heading`, 16 px below the mark), the composer (24 px below, `max-w-(--chat-max-width)`), then three action cards in a 3-column grid (12 px gap, 20 px below): `Card variant="interactive"`, `p-4`, leading icon `size-5 text-muted-foreground`, 20 px gap, title `text-sm font-medium`, subtitle `text-sm text-muted-foreground`. Phaethon's three: Create (Notes, plans, flashcards), Find (Answers in your files), Research (Sources and the web); each fills the composer with a starter. A secondary card may sit near the bottom (an `ArtTile` + title + line, like a163's "Connect your channel"), e.g. "Connect a course" when a study space has none. No art behind the hero; the dot matrix only.

### Chat — timeline

b583, f510, fd96, 91b5, 8a83, 7cad, d706.

- Column `max-w-(--chat-max-width)`, centred. User turn: right-aligned ink bubble (`bg-message text-message-foreground`, `rounded-xl`, `px-4 py-3`, `text-base`), attachments as a pill above it ("5 attachments" with the attach icon, `rounded-full border text-sm`). Long user text clamps at 12 lines with "Show more".
- Assistant turn: starts with the `ThoughtToggle` ("Thinking…" with spinner while reasoning, "Thought 12s" after); open, it shows a dot `StepList` in plain words. Then the prose (`.markdown`, 14/22). Then message actions as small outline icon buttons (copy, retry, like, dislike; fd96).
- Work (tools): one `ToolSummary` line per turn ("Read 2 files, edited 1, ran a command", duration on the right). While running: the spinner, the live step in plain words with `text-shimmer`, elapsed time; after 8 s a reassuring second line. Open: an icon `StepList` (tool glyph per row, a `tag` chip for the kind, file chips and output as `detail` in a `rounded-xl bg-code border` block with a copy button). Technical labels only with Settings › Show technical details.
- Sources used: a `Card variant="well"` with a header row ("3 sources used ⌄"), rows with the file glyph, "Show all" (fd96).
- Approval card (d706 left): `Card` with `p-3`; header row: blue `done` icon + "Draft is ready" in `text-primary text-base`; a `well` box with the draft and small rect buttons (Edit = ink, View changes = outline); under it `KeyActions` with "Y Accept" and "N Reject" (keys bound while the card is the newest pending one). Denied, accepted and expired states replace the bar with one muted line and an icon.
- Question card (d706 right): header "Needs your answer" with the blue info icon and "1 of 3" pager (chevrons); each question in a hairline-separated block (question `text-base`, the chosen answer muted below); a closing row with the spinner and "Preparing your draft…" while the agent continues.
- Limits and errors above the composer (fd96): a `well` card with an icon line, one sentence, Close + an ink action with its keys.

### Composer and model picker

a6e6, 95ba, a163, 8386.

- `Card` (`rounded-card`, hairline, `shadow-card`), textarea `text-base` with the placeholder "Ask anything…" (`text-placeholder`), min 3 lines. Toolbar row: attach as an outline `icon-sm` square, mode/context chips as `secondary` rect `sm` buttons with an icon (a "New" tint badge `text-primary` is allowed), then on the right the model picker (provider logo, model name, chevron; `ghost` `sm`), mic (ghost icon), and send: a round `icon-sm` button, ink when there's text, `bg-primary/30` disabled tint when empty (a6e6's pale blue circle), Stop (square) while running.
- Model picker popover (8386): `rounded-xl` popover, section label "Models", rows with the provider logo, name, and a 10-segment speed/strength meter in the provider's brand tint; the selected row has a check. Effort is a segmented control at the bottom.

### Study

- **Overview** (2c35, 0922, b72b): page title row ("Study" is in the tab, so the row shows "5 cards due" as a hero `Card` with `CardMedia` art strip (`lilac`, `weave`), title, one line "About 2 minutes · 5 new · 4-day streak", and an ink "Review due cards" pill). Below, a `StatGrid` (due, reviewed this week, mastery, streak). Then decks as a 2-column grid of artifact-style cards (b72b: a grey `well` frame holding a white inner sheet with the deck glyph and its first card's text, title below, "2 due · 6 cards" muted), then quizzes the same way with last score.
- **Make a quiz** (dc3a, 9091): a dialog `rounded-panel` with a title and description; source picker as selectable cards (three across, title, count, a soft footer strip like 9091's "Save 20%"); options as `ToggleRow`s and a `SegmentedControl` for length; a summary `Card variant="well"`; one full-width ink button "Make quiz" with `pending` and a progress line while it builds.
- **Quiz taking** (d706 right, 8c35): centred column; header with "Question 3 of 10", a thin progress bar in ink, close; question `text-xl`; answers as large `interactive` cards with a keycap (A–D) each; Check as an ink pill; feedback slides in under the answer (success or destructive tint, explanation). Keys: 1–4 / A–D, Enter.
- **Results** (c06d): a centred `Card` "You're all set"-style: art strip, score as `text-3xl`, a `well` list with blue tick discs per outcome, buttons "Review mistakes" (ink) and "Done" (outline).

### Grades

0922, 91b5, b583. Page `max-w-(--page-wide-max-width)`. Header row: course switcher as `SegmentedControl` or `Tabs` (segmented). A term `Card` with `CardMedia` (`meadow`) and the current grade as `text-3xl` plus a delta. `StatGrid` of four tiles (current, projected, best category, assignments left). "Breakdown": `StackedBar` + `BarLegend` by category with weight and percent. "Trend": a line chart in a card with a `SegmentedControl variant="outline"` range (1W 1M 3M Term). Assignment rows: hairline-separated, title, category tag, score `tabular-nums`, status badge (tint).

### Plan

7274, dc42, e0fb. A week/agenda layout: left a narrow column (`w-64`) of filters as sidebar rows with counts (e0fb's channels list with status dots); right the agenda: day headers (`text-sm font-medium`, date muted), items as rows with a time column, title, course tag and a status dot; drag handles on hover. Today's card at the top in `CardMedia` (`dawn`). Empty day: a quiet muted line. Planning an item opens a side sheet (`rounded-panel`, like 7274's right panel) with fields and an ink Save.

### Courses

7274, 02a1, 8bdf, dca9. A list/detail layout inside the page: left a 280 px pane ("Courses" title with the ink `+`, search field, a list of course sites as folders holding their courses with indentation, a count footer); right the detail with a breadcrumb row (pane toggle, `folder` glyph, chevrons; the site crumb gives way before the course's name) and actions (Import, `…`), then underline `Tabs` "Overview · Files · Settings" for the course (7274's "Crawl Links | Individual", dc42's "Editor · Runs · Scheduled"). Left-pane tabs only belong there when they switch the left list itself. Connect/import flows use dca9's marketplace layout: centred title, search field, an `ArtCanvas` banner with prompt pills, then "Featured" two-column rows (logo tile, name, one line, a `+` outline icon button or a check). Sync status uses tint badges ("Synced" info, "Pending" warning) as in 7274.

### Settings

e0fb, dc3a, 9e25, 8bdf. Left column (`w-64`) of section rows with icons and group labels (General, Appearance, Agents, Providers, Spaces, About), status dots or a usage badge on the right where useful. Right: a centred `max-w-(--settings-max-width)` column of `Card`s; each card: a header (logo tile 40 px + title `text-lg` + one line), then a segmented `Tabs` if the card has modes, fields with labels above (`text-sm`), and `ToggleRow`s in `divide-y`. Selects are compact (`ghost` with a chevron, "On all messages ⌄"). Dark mode reads as 9e25: panel at `--card`, rows with brand glyphs, blue switches.

### Onboarding

3940, e3e4, 2c35, d1d3, c06d, d922. Full window, no app frame chrome: left half on `--background` with the mark at the top, a centred form column (`max-w-sm`): title `text-2xl` weight 500, one line muted, the step's controls, a full-width ink button; step dots at the top (blue active bar, grey dots). Right half: an inset `ArtCanvas` panel (`rounded-panel`, `--frame-inset` margin, `animate`) holding a live, scaled preview of what the step sets up (a sidebar with spaces, a provider card). The finish step is c06d's "You're all set" card: a `well` list of what was set up with blue tick discs, Explore (ink) and Close (outline). Each step's art palette differs (`sky → dawn → meadow`).

### Viewer

02a1, 8bdf. The file viewer is a sheet over the main column (`rounded-panel` on the left edge, hairline, `shadow-popup`): a 48 px header with the file glyph, the name (middle-truncated), breadcrumb muted, and actions on the right (open externally, show in folder, copy path, `…`, close); the body scrolls with the document centred; a footer row for counts ("63 words · 375 characters") and Cancel/Save when editing. A side info panel (8bdf's "Skills info") is a 280 px column of label/value rows.

### Dialogs, menus, empty states

- Dialogs (9091, 8c35): `rounded-panel`, `p-6`, title `text-lg` + description; content in cards; footer with Cancel (outline) and the action (ink or accent), or one full-width ink button.
- Menus (8386): `rounded-xl`, header block allowed (avatar, name, email), rows `h-8` with icons, a tinted "New" badge on the right.
- Empty states: an `ArtTile` or `CardMedia` strip, one line title (`text-base font-medium`), one line muted, one ink or outline action. Never a lone grey icon in a void.

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
