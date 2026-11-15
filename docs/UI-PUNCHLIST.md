# UI punch list

Every ask since the UI complaints began, in order. Status: `done` (merged in main or committed on `ui/polish`), `todo`, `doing`. Nothing gets dropped from this list; items only change status.

## Round 1 — the original brief

| # | Ask | Status |
|---|-----|--------|
| 1 | Sidebar: half-thought-through, iffy state; must handle 1000+ chats | done |
| 2 | Fun animation with visible state | done |
| 3 | Several chats replying at once | done |
| 4 | Chat state kept across page switches | done |
| 5 | Top-right nav shifting | done — header is one fixed row; pages are tabs |
| 6 | File links in chat replies do nothing | done |
| 7 | Right-click menus and autocomplete | done |
| 8 | Grades: relevant work without scrolling to the bottom | done |
| 9 | Download every linked Canvas file | done |
| 10 | Command/tool view: friendly progress, technical detail opt-in | done, superseded by 42 |
| 11 | Thin, detailed icons from any library | done (Hugeicons) |
| 12 | Less safety friction | done |
| 13 | Quiz creation flow and quiz screen | done; see 26 |
| 14 | Colours oklch/oklab only | done |
| 15 | No arbitrary one-off constraints | ongoing |
| 16 | shadcn as the base for everything, radius +2–4 px | done |
| 17 | Match the reference layouts and icons | done |
| 18 | Abstract art (Linear-like) for empty spaces only, nothing that screams AI | done — pages stripped; keep the dot field (37) |
| 19 | Install the new build on the Mac | redo at the end (63) |

## Round 2

| # | Ask | Status |
|---|-----|--------|
| 20 | No window inside the window (inset frame) | done |

## Round 3 — `/clean-copy` and the chat UI

| # | Ask | Status |
|---|-----|--------|
| 21 | Think every page through; the chat UI was thrown together | done |
| 22 | Ugly scrollbars; stable gutters so content stays centred | done |
| 23 | Chat: no scrollbar; a message history bar like T3's (copy their implementation) | done — `HistoryRail`, after T3's minimap |
| 24 | One implementation per component (tab switcher etc.), app-wide | done — one `Tabs`; nav rows share one style |
| 25 | No box shadows; flat, minimalist | done |
| 26 | "Choose a topic" cuts off (overflow states) | done |
| 27 | Typography consistent; some screens too much, too little, too big | done — one scale: `text-lg` hero, `text-base` headings, `text-sm` body |
| 28 | Pointless subtitles removed | done |
| 29 | Duplicate info under study cards | done |
| 30 | 2–4 UI styles across the app → one; fix sequentially, no multi-agent UI work | done |

## Round 4 — the walkthrough

| # | Ask | Status |
|---|-----|--------|
| 31 | Settings nav style is good; use that same nav-row style everywhere else (plan filters, courses list) | done — plan filters, course list, settings nav and sidebar share the row |
| 32 | "Connect a model" shows although a model is set up; onboarding covers it → remove | done |
| 33 | Settings: switching Providers ↔ Coding agents reloads every time → cache; skeletons sized like the layout | done — `useLoad` remembers per loader and refreshes quietly |
| 34 | Providers: scroll to the bottom to see Gemini's usage → consolidate like T3; no pushed default provider; empty state + Add | done — one list, a row per provider that opens in place; no pushed default |
| 35 | Toggle switch: keep the blue (one blue app-wide), change the black thumb | done — white thumb |
| 36 | Shortcut key chips too big and detailed → flat, small | done |
| 37 | The dot background is liked → keep it on pages | done — restored |
| 38 | File / mention pill hover looks horrible | done |
| 39 | Open-page tabs so several pages can be open (like T3) | done |
| 40 | View tabs next to the logo are wrong; header shifts → views move, header stays put | done |
| 41 | Composer attach button too big | done |
| 42 | Command view: no exit codes; one line per command, click shows the command, more detail optional | done |
| 43 | Too many ⋯ menus | done — providers' ⋯ gone; others stay where they hold several actions |
| 44 | Sidebar chat row hover with a wrapped title looks horrible → one line | done — tooltips left-aligned, rows stay one line |
| 45 | Space colour as a lettered box is bad → colour as a line or dot, no letter | done — an 8 px dot |
| 46 | Space settings reload and clip on every click → cache | done (with 33) |
| 47 | Loading skeletons not sized to what they stand in for | done — cached sections skip the skeleton |
| 48 | Reply action buttons in circles → flat; the bottom of a reply must be visible | done |
| 49 | User message hover actions should not sit to the left | done — under the bubble, right |
| 50 | User bubbles too thick, too much padding | done |
| 51 | Thick borders → lighter hairlines | done — hairlines lightened |
| 52 | Grades: course strip doesn't show the classes and duplicates the tiles → remove the strip | done |
| 53 | Grades: the overview and the per-course page have no title, so it isn't obvious what you're looking at → title them | done |
| 54 | Courses: grey out / separate courses hidden from the space | done |
| 55 | Import courses dialog: parse terms, preselect the current one, tuck the rest away, preselect already-imported courses | done |
| 56 | Course files: hover is a border, should be a background; kind sections so pages aren't under 1000 files | done |
| 57 | Course settings: condense and centre | done — rows tightened; it sits in the settings column |
| 58 | Plan: left filter column shifts while scrolling → sticky | done |
| 59 | Plan: exams known from chats and course materials should appear automatically | done — exams the course's scope map dates show in Plan, marked "from the course" |
| 60 | Empty chat: "Add files to School" card looks ripped off → simpler | done |
| 61 | Logo: the P mark next to the word "Phaethon" doubles the P (UI and README) | done — the app shows the word only; the README banner regenerated without the mark |

## Finish

| # | Step | Status |
|---|------|--------|
| 62 | `docs/UI-REBUILD.md` updated to match (flat, one tabs, art rule, scrollbars, type scale) | done |
| 63 | typecheck, `pnpm test`, `pnpm test:ui`, light and dark screenshots of every page, PR, CI, merge, Mac build and install | done — PR #2 merged, Mac running it |

## Round 5 — `/clean-copy`

| # | Ask | Status |
|---|-----|--------|
| 64 | Walk every user-facing string down the clean-copy ladder: cut captions that restate the label, hedges about worries the user never had, explanations of the system | done — 24 strings cut or shortened; rule added to `docs/UI-REBUILD.md` |
