// Agent CLIs (Team Agent CLIs): Codex and Gemini CLI next to Claude Code. Behaviour checks: check(...) fails the run.
//   f11-settings   Provider rows show known installation/authentication status; keyboard popup controls explicitly choose Codex.
//   f11-missing    choosing Gemini CLI when it isn't installed says so with how to install it, and doesn't switch
//   f11-model      with Codex answering, a space's model button offers Codex's own default, then the models Codex itself lists
//                  (asked of Codex once, names and what each is for), Refresh the list (asks again, menu stays open, said) and
//                  Another model…, where a typed name is saved as codex:<name> (a name that could be a flag is refused at the
//                  field) and the default comes back; a listed model chosen by keyboard is saved and named as Codex names it
//   f11-model-lists Gemini CLI's menu lists the choices its own menu offers with a note that it can't list its models
//   f11-model-unlisted a Codex that can't list says so in words and Another model… still works; Settings opening asks again
//   f11-errors     a chat error names the CLI that answers and says to sign in to it in Settings, never in a terminal
//   f11-sign-in    with Codex answering, Settings signs in to it for this Phaethon folder by keyboard: the button keeps focus
//                  and says it waits for the browser, Stop signing in stops it (said), signing in again says it worked and
//                  Codex's choice now says signed in; with Gemini CLI, Google refusing the account is said in words; Claude
//                  Code and Phaethon's own assistant have no sign-in here
//   f11-empty      the empty conversation says Gemini CLI answers here, read-only
import { SETTINGS, check, openSettings, park } from "../audit-fixtures.mjs";
import { closeProviderPopup, openProviderConfiguration, providerPopup, useProviderDefault } from "../provider-flow.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = "[data-space-pane][data-shown]";
const picker = `${shown} [data-model-picker]`;
const settingsSaid = (page, text, timeout = 4000) =>
  page
    .waitForFunction((t) => [...document.querySelectorAll('[role="dialog"] p[role="status"]')].some((p) => p.textContent === t), { timeout }, text)
    .then(() => true, () => false);
const shellSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text).then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");

const CLIS = (over = {}) =>
  [
    { id: "claude", name: "Claude Code", installed: true, loggedIn: null, loginCommand: "claude", supported: true, ownHome: false },
    { id: "codex", name: "Codex", installed: true, loggedIn: true, loginCommand: 'CODEX_HOME="/x/default-codex" codex login', supported: true, ownHome: true },
    { id: "gemini", name: "Gemini CLI", installed: true, loggedIn: null, loginCommand: 'GEMINI_CLI_HOME="/x/default-gemini" gemini', supported: true, ownHome: true },
    { id: "opencode", name: "OpenCode", installed: false, loggedIn: null, loginCommand: "opencode auth login", supported: false, ownHome: false },
  ].map((c) => ({ ...c, ...(over[c.id] ?? {}) }));

export default [
  {
    name: "f11-settings",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, clis: CLIS({ codex: { loggedIn: false } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-cli-status]', { timeout: 3000 });
      const choices = await page.$$eval('[data-provider-row]', (rows) => rows.map((row) => ({ id: row.dataset.providerRow, status: row.querySelector("[data-cli-status]")?.textContent })));
      check(["anthropic", "claude-cli", "codex-cli", "gemini-cli"].every((id) => choices.some((c) => c.id === id)), "configured providers and installed assistants have rows", JSON.stringify(choices));
      check(choices.find((c) => c.id === "codex-cli")?.status === "Sign-in required", "Codex's known signed-out state is shown", JSON.stringify(choices));
      check(choices.find((c) => c.id === "gemini-cli")?.status === "Installed", "unknown Gemini authentication is not presented as signed in", JSON.stringify(choices));
      check(choices.find((c) => c.id === "claude-cli")?.status === "Installed", "Claude Code's unchecked authentication is not presented as signed in", JSON.stringify(choices));
      check(!(await page.$("[data-cli-can], [data-opencode], [data-cli-own-setup], [data-cli-history]")), "removed explanatory sections are absent");
      await park(page);
      await h.shot("choices");

      await openProviderConfiguration(page, "codex-cli", { keyboard: true, catalog: true });
      await useProviderDefault(page, "codex-cli", { keyboard: true });
      check(await settingsSaid(page, "Now using Codex."), "keyboard activation explicitly chooses Codex and says so");
      const sets = await calls(page, "settings_set_backend");
      check(sets.at(-1)?.backend === "codex-cli", "codex-cli is saved", JSON.stringify(sets));
      await page.waitForSelector("[data-cli-model-default]", { timeout: 3000 });
      const text = await page.$eval(providerPopup, (e) => e.innerText);
      check(/Models are chosen in each space/.test(text), "CLI configuration points to each space's model control", text);
      check(!/What is sent to|AGENTS\.md|\.codex folder/.test(text), "CLI configuration omits the removed disclosure paragraphs", text);
      check(!!(await page.$('[data-cli-sign-in="codex"]')), "Codex can be signed in to here", "");
      await park(page);
      await h.shot("codex");
    },
  },
  {
    name: "f11-missing",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, clis: CLIS({ gemini: { installed: false } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "gemini-cli", { catalog: true });
      await useProviderDefault(page, "gemini-cli");
      await page.waitForSelector('[data-cli-missing="gemini-cli"]', { timeout: 3000 });
      const box = await page.$eval('[data-cli-missing="gemini-cli"]', (b) => [b.textContent, b.querySelector("a")?.href]);
      check(/Gemini CLI is not installed/.test(box[0]) && /Install Gemini CLI/.test(box[0]) && /github\.com\/google-gemini/.test(box[1] ?? ""), "it says Gemini CLI is missing and links to installation", JSON.stringify(box));
      check((await calls(page, "settings_set_backend")).length === 0, "and doesn't switch");
      check(await page.evaluate(() => window.__MOCK__.settings.backend) === "phaethon", "Phaethon's own assistant stays chosen");
      await park(page);
      await h.shot("missing");
    },
  },
  {
    name: "f11-model",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      let label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(label[0] === "Model in School: Codex default, the model Codex chooses" && label[1] === "Codex default", "the button says Codex picks its own model", JSON.stringify(label));
      await page.click(picker);
      await page.waitForSelector('[data-model-menu] [role="menuitemradio"]', { timeout: 3000 });
      await h.idle();
      const items = await page.$$eval("[data-model-menu] [data-model-option]", (els) => els.map((e) => e.textContent.trim()));
      check(/^DefaultThe model Codex chooses/.test(items[0]) && items.at(-1) === "Another model…", "Codex's default first, then Another model…", JSON.stringify(items));
      check(/^GPT-6\.1-SolLatest workhorse/.test(items[1]) && /^GPT-6-Astra/.test(items[2]) && /^GPT-6-Luna/.test(items[3]), "then the models Codex lists, by its names, with what each is for", JSON.stringify(items));
      check(items.at(-2) === "Refresh the list", "Refresh the list before Another model…", JSON.stringify(items));
      check((await calls(page, "agent_cli_models")).every((a) => a.cli === "codex") && (await calls(page, "agent_cli_models")).length === 1, "Codex is asked once", JSON.stringify(await calls(page, "agent_cli_models")));
      check(!(await page.$("[data-cli-models-note]")), "no note: Codex lists its own models");
      await park(page);
      await h.shot("menu");
      // Refresh the list: asked again, the menu stays open, said.
      await page.click('[data-model-option="__refresh__"]');
      check(await shellSaid(page, "Codex offers 3 models."), "refreshing says how many Codex offers", await shellStatus(page));
      check((await calls(page, "agent_cli_models")).length === 2 && !!(await page.$("[data-model-menu]")), "asked again, menu still open", "");
      // A listed model, chosen: saved and named as Codex names it.
      await page.click('[data-model-option="gpt-6-astra"]');
      check(await shellSaid(page, "School now uses Codex · GPT-6-Astra."), "choosing a listed model says its name", await shellStatus(page));
      check((await calls(page, "space_model_set")).at(-1)?.model === "codex:gpt-6-astra", "saved as codex:gpt-6-astra", "");
      await page.waitForFunction((p) => document.querySelector(p)?.textContent.trim() === "GPT-6-Astra", { timeout: 3000 }, picker).catch(() => {});
      check((await page.$eval(picker, (b) => b.textContent.trim())) === "GPT-6-Astra", "the button shows it", "");
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      await h.idle();
      await page.click(picker);
      await page.waitForSelector('[data-model-option="__default__"]', { timeout: 3000 });
      await page.click('[data-model-option="__default__"]');
      check(await shellSaid(page, "School now uses Codex’s own default model."), "and back to the default", await shellStatus(page));
      // By keyboard alone: close, open from the button, start on the model in use, End reaches Another model….
      await page.keyboard.press("Escape");
      await page.waitForFunction((p) => !document.querySelector("[data-model-menu]") && document.activeElement === document.querySelector(p), { timeout: 3000 }, picker);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-checked") === "true", { timeout: 3000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.keyboard.press("End");
      await page.waitForFunction(() => /Another model/.test(document.activeElement?.textContent ?? ""), { timeout: 3000 }).catch(() => {});
      const at = await page.evaluate(() => document.activeElement?.textContent);
      check(/Another model/.test(at ?? ""), "End reaches Another model…, the last item", at);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-cli-model-dialog]", { timeout: 3000 });
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-cli-model-input"));
      check(focused, "the name field has focus", String(focused));
      const desc = await page.$eval("[data-cli-model-dialog]", (d) => d.textContent);
      check(/Enter a model name for Codex/.test(desc) && /For example gpt-5\.5/.test(desc), "the manual model field names Codex and gives an example", desc);
      // A name that could be read as a flag is refused, at the field.
      // Typed once the menu has finished closing, as a person would.
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      await page.keyboard.type("--yolo");
      await page.waitForFunction(() => document.querySelector("[data-cli-model-input]")?.value === "--yolo", { timeout: 3000 }).catch(() => {});
      const typed = await page.$eval("[data-cli-model-input]", (i) => [i.value, document.activeElement === i]);
      check(typed[0] === "--yolo", "the name is typed into the field", JSON.stringify(typed));
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-cli-model-dialog] [role=alert]", { timeout: 3000 });
      const err = await page.$eval("[data-cli-model-input]", (i) => [i.getAttribute("aria-invalid"), document.getElementById(i.getAttribute("aria-describedby").split(" ")[1])?.textContent]);
      check(err[0] === "true" && /isn’t a model name Phaethon can pass on/.test(err[1] ?? ""), "the refusal is at the field and described by it", JSON.stringify(err));
      await park(page);
      await h.shot("refused");
      await page.click("[data-cli-model-input]", { clickCount: 3 });
      await page.keyboard.type("gpt-5.5");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-cli-model-dialog]"), { timeout: 3000 });
      const sets = await calls(page, "space_model_set");
      check(sets.at(-1)?.space === "school" && sets.at(-1)?.model === "codex:gpt-5.5", "School saves codex:gpt-5.5", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses Codex · gpt-5.5."), "and says so", await shellStatus(page));
      await page.waitForFunction((p) => document.activeElement === document.querySelector(p), { timeout: 3000 }, picker);
      label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(label[0] === "Model in School: Codex · gpt-5.5" && label[1] === "gpt-5.5", "focus is back on the button, which shows the model", JSON.stringify(label));

      // Back to Codex's own default.
      await page.click(picker);
      await page.waitForSelector('[data-model-option="__default__"]', { timeout: 3000 });
      await page.click('[data-model-option="__default__"]');
      check(await shellSaid(page, "School now uses Codex’s own default model."), "the default comes back, said", await shellStatus(page));
      const last = (await calls(page, "space_model_set")).at(-1);
      check(last.model === null, "cleared with null (the core clears Codex's)", JSON.stringify(last));
    },
  },
  {
    name: "f11-model-lists",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "gemini-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.click(picker);
      await page.waitForSelector('[data-model-menu] [data-model-option="flash-lite"]', { timeout: 3000 });
      await h.idle();
      const items = await page.$$eval("[data-model-menu] [data-model-option]", (els) => els.map((e) => e.textContent.trim()));
      check(JSON.stringify(items.slice(1, 5)) === JSON.stringify(["Auto", "Pro", "Flash", "Flash-Lite"]), "Gemini CLI's own menu's choices", JSON.stringify(items));
      const note = await page.$eval("[data-cli-models-note]", (p) => p.textContent);
      check(/Gemini CLI can’t list its models: these are the choices its own model menu offers/.test(note), "with a note in words that it can't list them", note);
      await park(page);
      await h.shot("gemini");
    },
  },
  {
    name: "f11-model-unlisted",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "codex-cli" },
      threads: {},
      cliLists: { codex: { models: [], note: "Codex couldn’t list its models just now. Type a model’s name with Another model…" } },
    },
    async run(page, h) {
      // A Codex that can't answer: said in words, and a name can still be typed.
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.click(picker);
      await page.waitForSelector("[data-cli-models-note]", { timeout: 3000 });
      const said = await page.$eval("[data-cli-models-note]", (p) => p.textContent);
      check(/Codex couldn’t list its models just now/.test(said), "a list that couldn't be had is said in words", said);
      check(!!(await page.$('[data-model-option="__other__"]')), "Another model… is still there", "");
      await park(page);
      await h.shot("codex-unlisted");
      await page.keyboard.press("Escape");
      // Settings opening asks Codex again.
      const before = (await calls(page, "agent_cli_models")).length;
      await openSettings(page, h, "agent");
      await page.waitForFunction((n) => window.__calls.filter(([c]) => c === "agent_cli_models").length > n, { timeout: 3000 }, before).catch(() => {});
      check((await calls(page, "agent_cli_models")).length > before, "Settings asks the CLI for its list again", JSON.stringify(await calls(page, "agent_cli_models")));
    },
  },
  {
    name: "f11-errors",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "codex-cli" },
      threads: {},
      sendError: { code: "notLoggedIn", message: "Codex isn’t signed in for this Phaethon folder yet. Sign in to it in Settings › Assistant, then send your message again." },
    },
    async run(page, h) {
      await h.send("What is due this week?");
      await page.waitForSelector('[data-role="assistant"] [role="alert"]', { timeout: 5000 });
      const alert = await page.$eval('[data-role="assistant"] [role="alert"]', (a) => [a.querySelector("[data-error-title]").textContent, a.textContent]);
      check(alert[0] === "Codex isn’t signed in", "the title names Codex", alert[0]);
      check(/Sign in to Codex for this Phaethon folder in Settings › Assistant/.test(alert[1]) && !/terminal|Claude|`/.test(alert[1]), "the body says to sign in to Codex in Settings, never in a terminal", alert[1]);
      const detail = await page.$eval('[data-role="assistant"] [data-error-detail]', (d) => d.textContent);
      check(/isn’t signed in for this Phaethon folder/.test(detail), "the core's own words stay under Details", detail);
      const actions = await page.$$eval('[data-role="assistant"] [data-error-action]', (bs) => bs.map((b) => b.dataset.errorAction));
      check(actions.join() === "settings,retry", "Settings first, where signing in is, then Send again", actions.join());
      await park(page);
      await h.shot("not-signed-in");
    },
  },
  {
    name: "f11-sign-in",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, clis: CLIS({ codex: { loggedIn: false } }), signIn: { codex: { hold: true } } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "codex-cli");
      const start = '[data-cli-sign-in="codex"] [data-cli-sign-in-start]';
      await page.waitForSelector(start, { timeout: 3000 });
      const intro = await page.$eval('[data-cli-sign-in="codex"]', (g) => g.textContent.replace(/\s+/g, " "));
      check(/Sign in to Codex in your browser to connect it here/.test(intro) && !/AGENTS\.md|never sees your password/.test(intro), "sign-in instructions are concise", intro);
      const named = await page.$eval(start, (b) => [b.textContent, document.getElementById(b.getAttribute("aria-describedby"))?.textContent ?? ""]);
      check(named[0] === "Sign in to Codex" && /in your browser/.test(named[1]), "the sign-in button has a name and description", JSON.stringify(named));
      await page.$eval(start, (b) => b.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("ready");

      // By keyboard: Enter starts it; the button keeps focus and says it waits; pressing again does nothing.
      await page.focus(start);
      await page.keyboard.press("Enter");
      check(await settingsSaid(page, "Opening Codex’s sign-in in your browser. Come back here when you’ve signed in."), "it says the browser opens");
      await page.waitForSelector('[data-cli-sign-in-stop]', { timeout: 3000 });
      const waiting = await page.$eval(start, (b) => [b.textContent, b.getAttribute("aria-disabled"), document.activeElement === b]);
      check(waiting[0] === "Waiting for browser sign-in…" && waiting[1] === "true" && waiting[2], "the button says it waits, can't be pressed twice, and keeps focus", JSON.stringify(waiting));
      await page.keyboard.press("Enter");
      check((await calls(page, "agent_cli_sign_in")).length === 1, "pressing it again starts nothing", "");
      check((await calls(page, "agent_cli_sign_in"))[0]?.cli === "codex", "it signs in to Codex", "");
      await page.keyboard.press("Escape");
      check(!!(await page.$(providerPopup)), "Escape keeps pending sign-in configuration open");
      const locked = await page.$$eval('[data-provider-popup] [data-slot="dialog-footer"] button', (buttons) => buttons.every((button) => button.disabled));
      check(locked, "pending sign-in disables popup navigation until cancellation or completion");
      await park(page);
      await h.shot("waiting");

      // Stop signing in, by keyboard: said, and the button is back.
      await page.keyboard.press("Tab");
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-cli-sign-in-stop")), "Tab reaches Stop signing in", "");
      await page.keyboard.press("Enter");
      check(await settingsSaid(page, "Signing in to Codex was stopped."), "stopping is said");
      await page.waitForSelector('[data-cli-sign-in-outcome="cancelled"]', { timeout: 3000 });
      check((await calls(page, "agent_cli_sign_in_cancel")).at(-1)?.cli === "codex", "Codex's sign-in is the one stopped", "");
      await page.waitForFunction((s) => document.activeElement === document.querySelector(s), { timeout: 3000 }, start).catch(() => {});
      check(await page.evaluate((s) => document.activeElement === document.querySelector(s), start), "focus goes back to the sign-in button", await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));

      // Again, and this time it works: said, shown, and Codex's choice says signed in.
      await page.evaluate(() => (window.__MOCK__.signIn.codex = { status: "signedIn", message: "Signed in to Codex for this Phaethon folder." }));
      await page.keyboard.press("Enter");
      check(await settingsSaid(page, "Signed in to Codex for this Phaethon folder."), "signing in is said");
      await page.waitForSelector('[data-cli-sign-in-outcome="signedIn"]', { timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('[data-provider-row="codex-cli"] [data-cli-status]')?.textContent === "Signed in", { timeout: 3000 });
      const status = await page.$eval('[data-provider-row="codex-cli"] [data-cli-status]', (s) => s.textContent);
      check(status === "Signed in", "Codex's row shows authentication only after successful sign-in", status);
      await page.waitForFunction((s) => document.querySelector(s)?.textContent === "Change account", { timeout: 3000 }, start);
      check(await page.$eval(start, (b) => b.textContent === "Change account"), "a connected account offers Change account");
      await park(page);
      await h.shot("signed-in");
    },
  },
  {
    name: "f11-sign-in-gemini",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "gemini-cli" },
      threads: {},
      clis: CLIS(),
      signIn: {
        gemini: {
          status: "notSignedIn",
          message: "Gemini CLI is signed in, but Google no longer lets it answer with this account: the free plan for individuals now points to Google’s Antigravity instead. A Gemini API key set up in Gemini CLI itself, or a Google Cloud or paid plan, still works. Or choose another assistant in Settings.",
        },
      },
    },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "gemini-cli");
      const start = '[data-cli-sign-in="gemini"] [data-cli-sign-in-start]';
      await page.waitForSelector(start, { timeout: 3000 });
      check((await page.$eval(start, (b) => b.textContent)) === "Sign in to Gemini CLI", "Gemini CLI has its own sign-in control", "");
      const intro = await page.$eval('[data-cli-sign-in="gemini"]', (g) => g.textContent);
      check(/in your browser/.test(intro) && !/GEMINI\.md/.test(intro), "Gemini sign-in instructions are concise", intro);
      await page.click(start);
      await page.waitForSelector('[data-cli-sign-in-outcome="notSignedIn"]', { timeout: 3000 });
      const out = await page.$eval('[data-cli-sign-in-outcome="notSignedIn"]', (p) => p.textContent);
      check(/Google no longer lets it answer with this account/.test(out), "Google refusing the account is said in words", out);
      // Claude Code and Phaethon's own assistant: no sign-in here.
      await closeProviderPopup(page);
      await openProviderConfiguration(page, "claude-cli");
      await useProviderDefault(page, "claude-cli");
      await page.waitForFunction(() => !document.querySelector("[data-cli-sign-in]"), { timeout: 3000 }).catch(() => {});
      check(!(await page.$("[data-cli-sign-in]")), "Claude Code has no sign-in here", "");
      await park(page);
      await h.shot("refused");
    },
  },
  {
    name: "f11-empty",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "gemini-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-empty-reach]`, { timeout: 5000 });
      await page.waitForFunction((s) => /Gemini CLI answers here/.test(document.querySelector(`${s} [data-empty-reach]`)?.textContent ?? ""), { timeout: 3000 }, shown);
      const text = await page.$eval(`${shown} [data-empty-reach]`, (p) => p.textContent);
      check(/Gemini CLI answers here\. It can read and search the files in School/.test(text) && /can’t change any file/.test(text), "the empty conversation says Gemini CLI answers, read-only", text);
      const label = await page.$eval(picker, (b) => b.textContent.trim());
      check(label === "Gemini CLI default", "the model button says Gemini CLI picks its own", label);
      await park(page);
      await h.shot("empty");
    },
  },
];
