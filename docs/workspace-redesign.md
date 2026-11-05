# Personal workspace redesign

Final checkpoint: 2026-11-04. Implemented on `feat/vic-ui-migration` from local baseline `a328e5c`. This revision is for personal use: no Phaethon changes were pushed or published. The pre-existing untracked root `CLAUDE.md` was left untouched.

## Result

The redesigned app is installed at `/Applications/Phaethon.app` and its native 1100×720 window was observed on screen. The installed executable matches the tested bundle, SHA-256 `768a37e1281bed991550728711840ace51411b69c669b7644cd29513a0ed11cd`. Existing application data was preserved. The previous app is backed up at `~/Library/Application Support/Phaethon App Backups/20261104-215353/Phaethon.app`.

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

The first LaunchServices process exited without a diagnostic report. A subsequent direct launch of the installed executable stayed running with an on-screen window during the final check; no crash cause is inferred. If startup exits recur, inspect native startup/unified logs before reinstalling.

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
