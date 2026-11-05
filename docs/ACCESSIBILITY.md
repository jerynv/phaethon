# Accessibility

Keyboard and assistive-technology support remain part of the workspace. Visual focus rings are an optional personal preference, off by default; enable them in Settings → Accessibility → Show focus rings.

## Baseline already in the shell

- Landmarks: skip link, `nav` for spaces, `main` for the conversation, a labelled composer `form`, and a `log` region for messages.
- Streaming is silent: the `log` has `aria-live="off"`, so replies are not read token by token. One polite `status` region announces what the agent is doing ("Reading file notes.md") and then the whole reply once it completes ("Phaethon replied: …"), or "Reply stopped." Errors render inside the message as `role="alert"` and are announced immediately.
- While a reply runs, Send becomes "Stop reply"; Escape in the composer also stops it. If the reply ends while Stop has focus, focus returns to the composer.
- Every control has an accessible name; the composer has a real `<label>` and a described keyboard hint.
- When focus rings are enabled, controls use the chosen outline thickness (3px by default). The setting covers the composer and library control wrappers too; turning it off preserves the chosen thickness for later use.
- Follows the system light/dark setting live, and `prefers-reduced-motion` disables animation and smooth scrolling.
- Sidebar works with Tab and with ArrowUp/ArrowDown/Home/End.
- A file change the agent wants is an inline `alertdialog` ("Phaethon wants to change a file") with a plain summary, a focusable preview, and Allow / Don't allow. It takes focus when it appears and returns focus to the composer once answered; it is not also announced by the status region. A reply loaded from a saved thread is not announced.

## Requirements by disability category

### Blind and low vision

- Fully operable with VoiceOver, NVDA, JAWS and Orca. Every interactive element has a name, role and state.
- New assistant output is announced once, at a sensible granularity: streaming must not read every token. Announce on completion or by sentence, and let users choose.
- Message authorship is spoken ("You said", "Phaethon said"), not only shown by colour or alignment.
- Text contrast at least 4.5:1 (3:1 for large text and UI components) in both themes; respect OS text-size and zoom up to 200% without horizontal scrolling at the default window size, reflow at 320 CSS px wide.
- Forced-colours / high-contrast mode keeps selection and validation boundaries visible and respects the focus-ring preference.
- Images and generated charts carry text alternatives; code blocks are readable as text.

### Motor and switch access

- Everything remains reachable and operable by keyboard alone, with no keyboard traps. Focus indicators are available when enabled.
- Target size at least 24×24 CSS px (WCAG 2.5.8); primary actions larger.
- No action requires a drag, a multi-finger gesture, or precise timing; any drag has a single-pointer alternative (2.5.7).
- Works with switch control, voice control (Voice Control, Dragon) and dwell clicking: visible labels match accessible names (2.5.3).
- No timeouts on composing; long agent runs never auto-dismiss a confirmation.

### Deaf and hard of hearing

- No information conveyed by sound alone; any audio cue has a visual equivalent.
- Any audio or video the agent produces or plays gets captions or a transcript.
- Voice features are optional; text is always a complete path.

### Cognitive and learning

- Reading font is a setting (Settings > Accessibility): Atkinson Hyperlegible (default), OpenDyslexic, Lexend, or the system font. It applies to all interface text, is saved in the vault and applies before first paint.

- Plain language in UI copy; consistent placement of navigation and controls across spaces (3.2.3, 3.2.6 consistent help).
- The agent's actions are visible and reversible where possible; destructive actions confirm in plain words and say what will change.
- No information that must be remembered between steps (3.3.7 redundant entry); authentication never requires a cognitive test (3.3.8).
- Reduced-motion respected; no autoplaying or flashing content (nothing over 3 flashes per second).
- Users can slow the pace: optional "one step at a time" agent mode, and summaries before long output.

### Speech

- Nothing requires speaking. Voice input is an option alongside typing, never a replacement.
- Dictation and voice commands tolerate atypical speech, and failed recognition falls back to text without losing input.

## Process

- **Disabled testers from alpha.** Paid testers covering each category above take part from the first alpha build, not after launch. Their findings block releases on the same footing as crashes.
- Automated checks (axe-core or equivalent) run in CI against every screen, but pass/fail there is only a floor: manual screen-reader and keyboard passes are part of every release checklist.
- Every new component documents its keyboard model and accessible name before it merges. Radix and React Aria primitives are preferred because they ship tested keyboard and ARIA behaviour.
