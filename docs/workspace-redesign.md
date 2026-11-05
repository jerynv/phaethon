# Personal workspace redesign

## Walkthrough revision installed — 2026-11-05

Implemented locally on `feat/vic-ui-migration` from baseline `1ce201e`. The current app is installed at `/Applications/Phaethon.app` and left running. No Phaethon changes were pushed or published. The pre-existing untracked root `CLAUDE.md` remains untouched. The owner authorized the complete migration, personal replacement, unlimited captures and changes above the earlier PR-size cap.

The installed executable matches the signed bundle: SHA256 `674a54d354b4655b1a111187dc7fe653a3a983b02d207225fad3a3996a5e929c`. The previous app is backed up at `~/Library/Application Support/Phaethon App Backups/20261105-002134/Phaethon.app`; existing application data was preserved. PID42686 was alive at verification. Its own WKWebView reported116buttons, visible1100×720 content and an unfrozen prototype. Root inspected the newly generated native snapshot and observed the sidebar, actual conversation/figure and composer. `/tmp/phaethon-r2-native-proof.json` records the proof. The native screenshot stays outside the repository because it contains personal data.

### Requested outcomes

| Area | Result and evidence |
| --- | --- |
| Vic controls | Official603c207 includes the ed35c65 concentric button geometry and flat-switch API. Consumer switches use `look="flat"`; off thumbs use the local secondary foreground token so the track stays rimless and the knob remains visible. Real-browser computed thumb/track contrast>=3:1 passes light/dark and both sizes. No round-button geometry or package patch. |
| T3 Settings patterns | Stronger page/group/row hierarchy, compact Advanced appearance, actual font-face Vic Select, thinner visible slider thumbs with larger transparent targets. Manage opens account/launch configuration; independent Usage lives behind a sidebar quick action. Whole Add connection row is clickable. |
| Chat and sidebar | Aligned rail, quiet New icon, cog/Usage/Updates footer and left-side running/needs-answer/unread/draft states. History searches the whole archive with50DOMrows/page. Model search has no silent catalog cap, nested real access selection and content-sized tutor modes. Stop is a solid red square; Jump sits above the capped editor. |
| Stable menu interaction | Public synchronous initial search focus; internal pointer movement no longer redirects focus to search. The narrow permission flow failed twice before the relatedTarget guard, then passed8capture checkpoints. Search/keyboard/paging/120-model and3000-history paths pass after the final guard. |
| LMS interface | Compact connected-site rows, square local marks, progressive hints, stable overlay school search, compact selection and bounded Past courses. Saved/imported selections are reused; partial imports offer Resume. Progress/cancel can coexist with Settings, and the discard dialog is bounded. |
| Source browsing | Modules, pages, assignments and files open their permission-checked originals from Course sites or Study→course→Materials. Heading ordinals handle duplicate/math headings; fenced headings and UTF8 boundaries have native tests, and truncation is disclosed. |
| Import integrity | All selected courses/pages, explicit listing cycle/cap errors, SHA256 verification before metadata shortcuts, unchanged-file preservation, changed/corrupt-file replacement, resumable cancellation and OCR-child termination. Supported identity checks precede credential writes; reconnect reuses the same site/account. Moodle remains site-based. Generated practice belongs in the space's study/notes context; full-access CLI instructions are policy rather than an OS write barrier. |
| Rich previews | Ready-input Vic image zoom/pan/fit, numbered text, quoted/bounded CSV/TSV, status/retry and toolbar are integrated. Phaethon keeps authorized loading, classification, native opening, PDF, syntax colours and academic Markdown/math. Only image CSP adds blob URLs. No Office/media renderer is claimed. |
| Voice | User-initiated macOS Dictation; browser SpeechRecognition only where supported. Focused draft is preserved, failures permit retry and nothing auto-sends. Real recognition remains untested. |
| Stack decision | Keep Rust for native services, permissions, import/OCR and process supervision; keep React/TypeScript for UI. No rewrite was needed to fix this walkthrough. See `ARCHITECTURE.md`. |

### Package and handoff

Active archive `vendor/vic-ui-603c207.tgz`, upstream `603c20750e246ee194dea0667b9351295f994352`, SHA256 `5700e4f560e757ee007629b7c55fabc689d965c388c9ce1efa1bb86d2831257f`. Root independently verified the bytes and131runtime exports; upstream and the independent handoff report strict packed Bundler/NodeNext checks with historical exports preserved. Postmerge CI41971291603 passed and deployed. The verified V-Client source pack remains provenance/research, not a claim of Office/media support. Image20MiB encoded, text512KiB/20000lines, CSV1MiB/1000rows/60columns are renderer limits; the host retains I/O and decoded-image policy.

Consumer adoption results and off-thumb token feedback were sent to Vic owner thread `da9b659b-c548-4da7-ae28-cae82758823f`, receipt `message:mcp:2eb789d1-1c24-4863-9064-4d7a79c97eec:thread-send:567231a0-f39c-4df4-b434-5d70fb3eb6f9`. This handoff does not require another upstream release to use the installed app.

### Verification

- Final frontend design check, TypeScript and Vite build pass: `/tmp/phaethon-r2-pointer-final-build.log`. JavaScript units35passed/0failed.
- Complete Chromium suite:903checkpoints/0failed across4shards. Exact logs/counts: `/tmp/phaethon-r2-full-ui-results.json`. The last shard was rerun after migrating its old image selector; original natural-size/fit/removal assertions remain.
- The full903run predates only the final off-thumb colour and internal pointer-focus guard. Affected current flows pass44keyboard/switch/new-space captures plus8pointer permission captures; current Appearance12captures/0. Logs `/tmp/phaethon-r2-final-focus-confirm.log`, `/tmp/phaethon-r2-pointer-fix.log`, `/tmp/phaethon-r2-appearance-delivery.log`.
- Preview integration16captures/0, targeted image attachment4/0, complete gallery88/0, Study Materials12/0, LMS scale/forced-colours64/0. Root inspected selected actual output; these are fixture-based browser checks.
- Native `cargo test --tests`:497passed,0failed,21ignored across19executables (`/tmp/phaethon-r2-final-native.log`). Native startup-config regression rerun1passed after the CSP addition. No later Rust implementation changes.
- Final macOS bundle/signature/install and actual WKWebView output verified: `/tmp/phaethon-r2-native-delivery-bundle.log`, `/tmp/phaethon-r2-native-proof.json`.
- Mechanical detector ran once on40changed UI files; its single thick diff-edge warning was removed, retaining +/- signs and semantic fills. `git diff --check` clean at handback.

### Council and limits

Codex Terra's bounded recheck scored UI/core8.5/8.5. Claude Work's final review cleared prior blockers and scored UI7.5/core8 while shard3 and the contrast correction were pending. It caught the faint off thumb and identified the pointer-focus concern; both were then corrected and exercised. These are subjective sampled reviews, not user acceptance. Reports `/tmp/phaethon-r2-final-council-codex.md`, `/tmp/phaethon-r2-release-council-claude-work.md`, and independent preview integration review `/tmp/phaethon-r2-preview-integration-review.md`. Default Claude hit its rate limit; the user-authorized Claude Work provider was used. Only two provider families were available.

Real new-account LMS identity/sign-in, real text-recognition cancellation, Keychain write prompts and microphone recognition were not exercised this revision. Fake local HTTP/process tests establish integrity/cancel behavior, not live service compatibility. Native output verification establishes rendering, not a complete native click-through. A complete accessibility audit remains deferred; the off-switch fix does not establish whole-app AA compliance. No Calendar sync, new RAG model runtime, Office renderer or media renderer was added.

All implementation and review workers have completed. The integrated changes are recorded as one coherent local increment; no further implementation or upstream preview work is required for this increment. Test browsers close through their runner; no owned live preview tab/server remains. The installed app is intentionally left running. Current seeded gallery: `/tmp/phaethon-r2-gallery.html` (40images; shown inline after HTML preview validation). Future visual feedback should be reproduced against this installed build.

## Previous revision: native startup correction verified

The previous window/process check missed a real black-window defect: a native-only `Object.freeze(Object.prototype)` script threw in D3 before React. Temporary dependency patches exposed the same issue in Dayjs/diagram code and were removed. The app now uses the existing Tauri `freezePrototype:false` configuration without a manual override. This removes optional prototype hardening; CSP, command ACLs and native filesystem checks are unchanged. The official Vic archive, dependency versions and lockfile remain unchanged.

The browser runner now reads the native configuration. The new `native-startup` scenario requires rendered controls and working Settings; a native unit test prevents an untested startup override. Final verification: **60 targeted Chromium checkpoints, 35 JavaScript tests and 481 native tests passed** (21 native probes ignored). The target flows cover boot, conversations, Settings, account management, palette density, course quiz and lazy Mermaid diagrams in light/dark at 1100×720 and 640×480. Full native coverage was rerun; the historical 840-checkpoint browser suite below was not repeated for this correction.

The final rebuilt application replaced the intermediate repair, preserving data. Its own macOS WKWebView reports 75 controls, a visible 1100×720 root and an unfrozen prototype. A newly written native snapshot at `/tmp/phaethon-final-fixed-native.png` has the same pixels as the inspected working native capture: sidebar, conversation, composer and Settings are rendered. Signature and installed/built executable hashes match. This establishes native rendered content, beyond the earlier process/window check; it does not claim a complete native click-through.

Logs: `/tmp/phaethon-compatible-native-build.log`, `/tmp/phaethon-compatible-native-bundle.log`, `/tmp/phaethon-boot-compatible-regression.log`, `/tmp/phaethon-boot-final-js-unit.log`, `/tmp/phaethon-boot-final-native-tests.log`, `/tmp/phaethon-final-fixed-native-startup.log`. Opt-in `PHAETHON_DIAGNOSTICS` and launcher-only `PHAETHON_SNAPSHOT_PATH` provide future native proof without screen-recording access. The screenshot remains outside the repository because it contains personal conversation data.

All review workers finished; both reproduction servers and the preview tab are closed. The installed app is left running. No dependency patches or implementation work remain pending. If another black window occurs, capture the native diagnostics/image before interpreting process exit or window existence as success.

Final checkpoint: 2026-11-04. Implemented on `feat/vic-ui-migration` from local baseline `a328e5c`. This revision is for personal use: no Phaethon changes were pushed or published. The pre-existing untracked root `CLAUDE.md` was left untouched.

## Result

The redesigned app is installed at `/Applications/Phaethon.app` and its native 1100×720 window was observed on screen. The installed executable matches the tested bundle, SHA-256 `d4016da1122a945c3fd5b6b160dce92a8b9cb7ade84e23b14f785eb418ea752b`. Existing application data was preserved. The previous app is backed up at `~/Library/Application Support/Phaethon App Backups/20261104-224719/Phaethon.app`.

The application now consumes the released upstream Vic UI archive from `a2521a914b02d4c8acefccead2d04e44d300e489`. Its verified SHA-256 is `b109c04e29336e7da6c137a0b42d330d64bcb4ac05bfc52656a0f72316c6a028`. The private compatibility port, flat accent-face overrides and circular-button workaround are retired. Package provenance and update instructions are in `vendor/README.md`.

Keep the hybrid stack: Rust for native services, permissions, OCR and process supervision; React/TypeScript for the interface. Rewriting either side would not resolve the UI problems. See `ARCHITECTURE.md` for the tradeoffs.

## Acceptance

| Requested outcome | Implemented behavior and evidence |
| --- | --- |
| Remove decorative framing, underlined controls and obvious tutorial copy | Flush workspace, shared surface hover, compact history and metadata. Button hover no longer underlines; actual text links retain their treatment. Browser assertions and rendered inspection passed. |
| Use the actual Vic palette | Command and conversation search use the library palette with bounded, content-sized results. Selection, Escape and focus return were exercised. |
| Hierarchical sidebar and stable switching | Independently expandable space/conversation groups reuse the existing lifecycle controller. Chat, Study, Grades and Plan remain mounted; drafts and quiz state survive navigation. Course overview data publishes together. |
| Compact chat menus and proper round buttons | Attachment/model rows align primary text and secondary metadata; native Vic round Send/Add retain circular rim and face. Transcript actions and time appear on hover/focus. |
| Consistent Settings across sections | One fixed header and Close above navigation/content; bounded frame, stable scrolling, compact Appearance and About, real font dropdown and native switches. Focus-ring preference remains off by default. |
| Space editing and creation | Separate editor with explicit Save/Cancel; no Enter/blur autosave. New-space flow chooses details, location, education and actual CLI access. Failed permission writes retry without duplicate creation. |
| Course-site identity | Local IU, Moodle and Canvas marks; existing import/disconnect/reconnect flows retained and exercised. |
| Multiple provider accounts and custom launches | Named CLI instances, local managed account homes, custom executable and literal argv arrays, actual selected runtime and account-specific resume tags. Default is a badge, not persistent hover styling. |
| Auth, recovery and usage | Official CLI login/status/logout; login exit status and cancellation checked. Real read-only Claude/Codex usage probes returned account windows without a model turn. Unavailable limits remain explicit. Mocked/fake-CLI flow checks passed; real new-account login/logout was not performed. |
| Optional education and course hierarchy | New spaces default to education off. Existing academic capability derives from validated course grants/study files. Study and Grades start with course selection. |
| Useful Plan and Quiz | Plan shows week-filtered agenda before scheduling detail; timer is secondary. Quiz supports single/all questions, flags, persisted answers/position, optional source Details and contextual AI help without answer leakage. Narrow footer/deadline visibility was checked. |
| Handwriting and academic sources | Page headings stay attached to source chunks. Permission-aware `read_page` supplies labeled original page images, bounded to six per turn and known image-capable models. Native OCR sample and source/tool tests passed. Paid model interpretation was not run. |
| Personal build usable now | Frontend build, native bundle, signature, installed hash and running visible window checked. Current screen gallery shows seeded fixture data, not the user's private conversations. |

## Verification of the final upstream consumer

- `pnpm build`: design check (144 files), TypeScript and Vite passed.
- `node --test scripts/unit/`: 35 passed.
- Complete Chromium scenario suite in four shards: **840 checkpoints, zero failed runs** (213 + 215 + 192 + 220). The scenario runner's supported sharding was used, not a reduced substitute suite.
- Additional focused runs passed for new-space keyboard flow, reduced-motion API/Codex composer focus, model-catalog switching, Claude recovery actions, actual reading-font persistence and tutor mode.
- `cargo test --tests`: **481 passed, zero failed, 21 ignored** across 19 executables. Ignored external/platform probes are not claimed as passed.
- Installed Codex/Gemini isolation tests: **3 passed** against local fake model servers; no real provider turn.
- Official upstream capture pass: **132 screenshots generated**, zero failed capture scenarios, across light/dark and 1100×720/640×480. Reviewers and root inspected selected rendered states; not every image received independent review.
- Native macOS app bundle and installed code signature verified; installed executable equals the built executable.
- `git diff --check`: clean at final handback.

A live reduced-motion failure was reproduced before correction: the global 0.01ms transition rule created visibility transitions on retained panels and made composer focus fail. Both reduced-motion rules now use zero transition duration. The old rule failed all four focused variants; the corrected rule passed sixteen theme/size/provider variants. A real preview interaction then confirmed Quiz → AI help focuses the composer, includes source context and does not send automatically, with no experimental style or instrumentation.

The first LaunchServices process exited without a diagnostic report. A subsequent direct launch stayed running, but window existence did not establish rendering; the startup correction above supersedes that check. No crash cause is inferred. If startup exits recur, inspect native startup/unified logs before reinstalling.

## Design review

Actual T3 reference source: `/tmp/phaethon-t3-layout-reference`, commit `7f6f47b27b44456f1c8214d3b566b375c09f629e`. The sidebar, palette, composer and provider-instance patterns were inspected and adapted to Vic controls. Source comments credit the relevant MIT implementations.

The final independent review judged the inspected Phaethon captures at 8/10 overall, with density 7.5/10 and the remaining dimensions 8/10. T3 was provisionally 8/10 from source inspection, not a live side-by-side comparison. Education had no identified T3 equivalent. These are subjective design judgments, not proof of user acceptance. No concrete release blocker was identified in the inspected captures. Optional follow-up: tighten provider-dialog section gaps and simplify repeated colour labels. An earlier Astra review was unavailable because of its usage limit; it was not counted as a successful review.

## Evidence and scope limits

- Gallery: `/tmp/phaethon-workspace-gallery.html` (32 current upstream images, seeded fixtures).
- Full UI results: `/tmp/phaethon-final-ui-suite.json`; logs `/tmp/phaethon-upstream-full-{1,2,3,4}.log`.
- Native results: `/tmp/phaethon-native-final.log`, `/tmp/phaethon-final-cli-isolation.log`.
- Read-only account probes: `/tmp/phaethon-live-usage.log`, `/tmp/phaethon-live-codex-usage.log`.
- Rendered consumer review: `/tmp/phaethon-upstream-visual-report.md`; final design review: `/tmp/phaethon-final-ui-council.md`.
- Live focus proof: `/tmp/phaethon-final-live-proof.json`; installation proof: `/tmp/phaethon-final-installed-proof.json`.

Chromium fixture flows do not establish every native WKWebView interaction. Real new-account sign-in/sign-out, Windows/Linux native flows, paid handwritten-page interpretation and a complete accessibility audit remain untested. Native Calendar synchronization was not added; Plan uses imported deadlines and saved exams. The API assistant has no arbitrary URL downloader; authenticated LMS import and permitted CLI tools remain the download paths. No second vector-model runtime was added without corpus evaluation.

All source workers and review tasks have finished. Root's preview tab/server were closed at handback; the installed native app is intentionally left running. No implementation step remains pending. The next product decision is the owner's review of the installed screens; any further visual objections should be reproduced against this build rather than the rejected earlier captures.
