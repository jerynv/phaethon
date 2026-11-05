# Personal workspace redesign

## R4 correction installed: actual catalogs and full walkthrough gaps

Baseline f45cf13 on feat/vic-ui-migration. The owner reopened the full walkthrough after finding the old Claude help-parser explanation and missing reasoning. The corrected app is installed at /Applications/Phaethon.app and left running (PID6291). SHA256 bf92aed79024ab160dc28b12b4b449ac80f00be5d9f91f2ce3d242908a56e799 matches the final signed source bundle. Previous app backup: ~/Library/Application Support/Phaethon App Backups/20261105-033719/Phaethon.app; original backup remains retained. Personal data preserved, untracked CLAUDE.md untouched, no Phaethon push/publication.

### Full walkthrough reconciliation

Independent read-only audit /tmp/phaethon-r4-walkthrough-gaps.md inspected all14brief areas and identified7concrete gaps. Source review is not behavioral proof. The corrections below have direct verification; the previously implemented general-page flows retain their R3 evidence rather than a fabricated10/10 claim.

| Gap | Implemented correction and evidence |
| --- | --- |
| Claude help aliases and missing reasoning | Claude uses initialize control metadata: full canonical names, aliases, real default and model-specific native efforts. Codex uses paginated app-server model/list with actual default/efforts; debug metadata is fallback. Metadata-only live probes observed13Claude/8Codex entries, no user/model turn or account details logged. Version-filtered T3 manifest fallback retained for offline Claude. Successful catalogs have no explanation paragraphs. Reports /tmp/phaethon-r4-model-catalog-report.md and /tmp/phaethon-r4-reasoning-runtime-report.md. |
| Study ignored the selection | Chat and Study resolve the perCLI/permodel preference, apply real Claude --effort / Codex model_reasoning_effort and preserve the captured setting through workflow/retry. Study text AND image calls retain their no-tools/read-only limits. FakeCLI tests cover construction→argv/payload, later setting changes, Default/reset and unsupported no-spawn. /tmp/phaethon-r4-study-selection-report.md. |
| Silent import prefixes | Brightspace refuses absent/repeated/unsafe/capped continuation, including Dropbox pagination. Canvas no longer silently cuts referenced files at300. Actual350file fakeHTTP import/reimport yields350unchanged/0downloads and unchangedmtime; existing corruption/hash/cancel tests pass. Discovery limits remain200Brightspacepages/100Canvaspages/10kCanvasreferences, with explicit Incomplete above them rather than false completion. No persisted discovery cursor beyond those caps is claimed. /tmp/phaethon-r4-import-completeness-report.md. |
| Education commands in Work | Palette view commands use visibleViews; due/quiz/deck commands require supportsEducation. Tests prove noneducation Work omits those actions, and saving Education enables them in both themes/widths. /tmp/phaethon-r4-education-confirm.log. |
| Collapse erased unread | Conversation state observers remain mounted through folder/sidebar visibility; portal controls and lazy history follow visibility. Unread is keyed by conversation; collapsed folder marks it, repeated collapse preserves it, opening the actual conversation acknowledges it. New completion-while-collapsed scenario passes. This does not claim unread persistence across app restarts. |
| Missing colored Full access pill and Blackboard mark | Vic Badge uses the semantic danger tint in the picker/Settings. Blackboard uses the exact local512PNG embedded in its official favicon SVG; URL/SHA provenance in assets/course-sites/sources.json. Actual decoded image and affected light/dark render inspected. |
| Remaining tutorial copy | Removed custom-model instruction/example paragraphs and successful-list coaching; provider/context remain in title, example in placeholder, errors remain associated with field. Settings API search renders all matches rather than silently capping50. Tests exercise120models/search/custom entry. |

### Final verification

- Final complete Chromium suite:938checkpoints/0failed scenarios across4shards, immutable /tmp/phaethon-r4-delivery-dist. Totals/logs: /tmp/phaethon-r4-ui-results.json and /tmp/phaethon-r4-delivery-shard-{1,2,3,4}.log.
- Native cargo test --tests:527passed/0failed/21ignored across19executables: /tmp/phaethon-r4-walkthrough-native-all.log. This includes the combined492library checks for Study, import and catalog/runtime changes.
- JavaScript units35passed/0failed: /tmp/phaethon-r4-js-unit.log. TypeScript, Vite and design checks pass; git diff --check clean. Mechanical detector ran on the model scope and newly expanded App/Settings/sidebar scope with zero findings.
- Focused model/persistence/keyboard cases48/0 on the delivery build: /tmp/phaethon-r4-delivery-targeted.log. They prove focus returns after async effort saving, Escape closes the actual picker, reopen restores the selection, and failed writes retain prior state.
- Rendered reasoning12captures/0 and affected pill/logo6captures/0; root inspected desktop/narrow light/dark samples. /tmp/phaethon-r4-reasoning-confirm.log and /tmp/phaethon-r4-walkthrough-captures.log. Later fixes preserve resolved names during refresh, restore focus after save and remove obsolete success-list coaching; final complete suite checks those paths.
- Final native signature/bundle hash/process and fresh WKWebView rendering inspected: /tmp/phaethon-r4-native-proof.json, /tmp/phaethon-r4-delivery-native-bundle.log, /tmp/phaethon-r4-install.log. Own WKWebView reports95buttons, visible1100x720 and unfrozen prototype. Root observed actual conversation, sidebar and resolved Codex model name. Native image remains outside Git because it contains personal conversation data.

Initial failures remain in diagnostic logs; they are not claimed clean. They exposed invalid-model preference lookup changing the existing filter contract, lazy-expansion dependency, metadata-name loss during refresh and focus loss after async effort save. Each cause was corrected and affected flows rerun. One intermediate UI shard exited ENOENT when root rebuilt shared dist; it was discarded and the final suite uses an immutable build. Stale tests asserting removed tutorial copy/capped50rows were migrated while preserving error association, full catalog reachability, persistence and actual action assertions.

### Evidence limits and cleanup

No paid live inference turn at a selected effort was performed. Actual model metadata and installed-CLI contracts plus fakeCLI argv/payload tests establish propagation, not provider answer quality. New real-account browser auth, real signed-in LMS import/reimport/OCR cancellation and actual microphone recognition remain unverified. Prior known axe findings remain deferred; this is not a whole-app accessibility audit. Gemini retains its installed CLI menu aliases and exposes no invented native reasoning control. No Calendar sync, new RAG runtime, Office or media renderer is claimed.

All workers and audit are complete/frozen. No owned preview tab/server remains. Final runner processes exited; the installed app intentionally stays running. Source references and failed/clean evidence are retained in /tmp reports. Further product feedback should be reproduced against this installed correction, with actual failures kept distinct from historical-content issues or untested live integrations.

## R3 correction installed: literal T3 structure and complete discrepancy coverage

Baseline0e59501 on feat/vic-ui-migration. The owner rejected the prior adaptation: source references and passing tests did not satisfy the required T3 composition. Every item below is required. Preserve the untracked CLAUDE.md, personal data and the running installed app until a verified replacement is ready. Existing personal installation/>400line/capture/agent authorizations continue. Capture general pages in one bounded batch and one confirmation, not every possible state. No publication requested.

| Owner discrepancy | Required result/check | State/owner |
| --- | --- | --- |
| Model selection still unlike T3 | Actual provider/account rail, inline combobox/list, compact normal-weight model rows and real footer controls; same T3 composition through Vic components. Browse accounts without changing active runtime. | implemented; verification below |
| Missing Vic primitive ignored | Released Vic inline Combobox composes the actual search/list/items and owns interaction. Temporary controller retired;137runtime exports verified. | implemented; verification below |
| Settings containers lost | Restore explicit rounded grouped containers matching T3 SettingsGroup, coherent inset/header/actions; remove floating divide-only lists. | implemented; verification below |
| Coding assistant management not T3 | Actual T3 master/detail provider list and editor; bounded Add dialog, named multiple accounts and executable/argv controls remain real. | implemented; verification below |
| Empty API heading | Render configured API services only; no empty group heading. Single clear Add connection entry still offers API services. | implemented; verification below |
| Text/buttons too bold | Normal-weight labels/rows/buttons, restrained medium selected/group headings; reduce excessive semibold. | implemented; verification below |
| Course-site hairline/bottom borders | Proper containing surfaces and complete consistent perimeter; remove floating row dividers/shadow edges; inspect actual render. | implemented; verification below |
| Settings icon still sliders | Map settings to actual Lucide cog, inspect footer. | implemented; verification below |
| Usage needs every account at once | One account-wide view, independent loading/error/unavailable, all connected instances visible without dropdown selection. | implemented; verification below |
| False Codex weekly0 | Parse main Codex usage bucket rather than unrelated model-specific legacy bucket; missing data stays unavailable. Prove with protocol fixtures. | implemented; verification below |
| Multiple subscriptions/custom arguments obscured | T3 instance management explicitly exposes actual accounts and argv; model rail resolves catalogs in each account's own home. No fake options. | implemented; verification below |
| Every button labelled/icons too thick | Icon-only secondary actions with useful names/tooltips, default thinner line weight, normal text hierarchy. | implemented; verification below |
| Spaces/directories not T3 hierarchy | Actual project-folder shelf headers with trailing chevron/count/new action and indented conversation rows; educational navigation stays subordinate to current space. | implemented; verification below |
| Every general page needs inspection | Batch main Chat/Study/Grades/Plan and all general Settings pages, plus picker/provider/add/usage representative overlays. Independent review tied to actual captures; no invented10/10 or review-score completion gate. | implemented; verification below |
Implementation is integrated in the shared checkout; all three native workers are finished/frozen. Root owns the final check/install. The model picker now uses the released Vic inline Combobox directly: its temporary active-index/keyboard/pointer/scroll controller is removed. Provider management uses T3's CLI master/detail layout, named accounts, executable and literal argv fields. Empty API groups are hidden. Configured API services retain their existing focused key/model editor rather than claiming the CLI account protocol.

The active dependency is vendor/vic-ui-6deb7fc.tgz, source6deb7fcf0b0cb04d394111ed9b879cb3e70b8619, SHA256 fbfb7f3946c0aa3a58d7bca4199f86e90919164640e0b4951a138479980ee8e4. Root verified the archive bytes; all137 root exports include the historical controls/previews. Upstream CI and Pages41980999493 passed. Consumer evidence: actual Vic keyboard/IME, busy rejection, async failure/retry, favorites, account selection and rollback14checkpoints/0fail in /tmp/phaethon-r3-vic-picker-final-proof.log. Historical62picker checks used the earlier temporary controller and are not claimed as testing the released primitive.

Codex usage diagnosis has two parts: parser normalization now prefers the main account bucket and derives window labels from duration; the live system and Phaethon-managed homes are also DIFFERENT accounts. A sanitized read-only official-CLI probe observed managed Weekly0% and system Weekly76%. Those values must never be substituted between accounts. Explicit codex-system and gemini-system entries expose available global homes read-only; changing the default is explicit. Phaethon never copies credentials or writes its instance marker into external homes. The CLI can still perform its ordinary cache/log/auth-refresh writes. System selection follows that CLI instruction home; managed instruction isolation is not claimed for an explicitly selected System connection. Metadata-only evidence: /tmp/phaethon-r3-codex-live-sanitized.json and /tmp/phaethon-r3-system-live-probe.log. No account was selected or signed in/out by the diagnostic.

Root restored full grouped Settings containers, restrained row/button weights, Lucide cog and1.5icon stroke; course-site row perimeter/aligned actions; actual T3 folder shelves with quiet trailing actions; closed-composer account identity; native Vic Select for Plan controls; all-account Usage. The general-page batch covered14representative pages/overlays in both themes. Independent Claude review /tmp/phaethon-r3-general-pages-review.md identified clipped rail, tiny identity badges and invisible flat tracks. One correction batch fits the whole five-account rail, scales the badge, identifies the account in the composer and gives the rimless switch a contrasting fill/knob. Final general-page confirmation30captures/0failed: /tmp/phaethon-r3-general-confirm.log. Root inspected the corrected actual images. This is sampled design evidence, not a10/10 or whole-app accessibility claim.

Verification so far:
- Full native tests508passed/0failed/21ignored across19executables: /tmp/phaethon-r3-full-native.log. No later Rust edits.
- JavaScript35passed/0failed; TypeScript/design/Vite pass: /tmp/phaethon-r3-full-ui.log (complete browser suite still running).
- Current affected settings/picker/provider/Plan controls72checkpoints/0failed across light/dark and applicable desktop/narrow: /tmp/phaethon-r3-affected-confirm.log. Both knob/track and track/group contrast>=3 pass, retaining rimless tracks and keyboard toggles.
- General-pages axe scenario assertions pass, but axe reported25label-content-name-mismatch nodes and1aria-required-children node across states; this is not a clean accessibility audit. Whole-app accessibility remains deferred by the owner. Forced-colours general-page assertions16/0 pass: /tmp/phaethon-r3-general-forced.log.
- Mechanical detector ran once after the correction batch: /tmp/phaethon-r3-design-detector.json, zero findings. git diff --check clean.

Active resources: own preview fixture server PID24906, port4079, /tmp/phaethon-r3-preview-server.mjs; own T3 preview tab tab_14_4ab4099e-78d5-4500-b37e-01277a2ffa19. Both resources have now been closed by root; do not terminate any other browser/server. The first complete UI run ended870checkpoints/41failed scenarios; most were stale popup/label/sidebar assertions, but it also exposed real missing New shortcut metadata, long-name activity reflow and inline sign-in dismissal. These are fixed; immediate Escape/cancel/focus, stable running header, real shortcut and actual semantic status assertions pass. The sign-in busy state publishes before paint through useLayoutEffect; Settings Close/Escape/section switching wait for completion or explicit cancel. Test migrations preserve persistence/default/auth/error assertions. The closed trigger also retains canonical names such as Codex instead of stripping them to an empty account alias.

Final source is frozen. The final complete Chromium suite passes929checkpoints/0failed scenarios across4shards on the frozen integrated source. Exact totals/logs: /tmp/phaethon-r3-full-ui-results.json and /tmp/phaethon-r3-release-shard-{1,2,3,4}.log. This rerun includes the migrated legacy assertions and all final source fixes. Final pnpm build passes; native final bundle session92876. Final native bundle is now personally installed at /Applications/Phaethon.app and left running, PID75300. SHA2564d01f9cff340db33f7f4ad7216ed718ec60e8b4c881a94c149f4c7a1e41d8aa6 matches source bundle; codesign verification passes. Prior app backup: ~/Library/Application Support/Phaethon App Backups/20261105-020419/Phaethon.app. Original backup remains retained. Personal data preserved. Fresh WKWebView proof reports124buttons, visible1100×720 and unfrozen prototype; root inspected the newly written native image and verified sidebar/conversation/composer and nonempty Codex account identity. Evidence /tmp/phaethon-r3-native-proof.json, /tmp/phaethon-r3-final-native-bundle.log, /tmp/phaethon-r3-final-install.log. Native image remains outside the repository because it contains personal conversation data.

All implementation, integration, required source checks and final installation for this correction are complete. Changes are local only; no Phaethon publication/push. Next independent action is a real signed-in LMS/voice flow if desired; fixture tests do not establish those live integrations. No remaining implementation workers or owned preview server/tab. The installed app intentionally remains running. Preserve existing data and untracked CLAUDE.md.

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
