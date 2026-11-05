import { PANEL, SETTINGS, check, openSettings } from "../audit-fixtures.mjs";

const dialog = "[data-agent-instance-popup]";
const calls = (page, command) => page.evaluate((command) => window.__calls.filter(([name]) => name === command).map(([, args]) => args), command);

export default [
  {
    name: "agent-instances-model-catalog",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "codex-cli" }, threads: {},
      cliLists: { codex: { models: [{ id: "personal-model", name: "Personal model" }] } },
      agentInstances: ["codex", "codex-work"].map((id) => ({ config: { id, cli: "codex", name: id === "codex" ? "Codex" : "Codex Work", binary: "", args: [] }, installed: true, loggedIn: true, account: null, plan: null, managedHome: true })),
    },
    async run(page, h) {
      await h.click('[data-model-picker="school"]');
      await page.waitForSelector('[data-model-option="personal-model"]');
      await page.keyboard.press("Escape");
      await page.evaluate(() => { window.__MOCK__.cliLists.codex = { models: [{ id: "work-model", name: "Work model" }] }; });
      await openSettings(page, h, "agent");
      await h.click('[data-agent-instance="codex-work"]');
      await page.waitForSelector(dialog);
      await h.click('[data-instance-select]');
      await page.waitForFunction(() => window.__calls.some(([name, args]) => name === "agent_instance_select" && args.id === "codex-work"));
      await page.keyboard.press("Escape");
      await page.waitForFunction((selector) => !document.querySelector(selector), {}, dialog);
      await h.click('[data-settings-header] button[aria-label="Close settings"]');
      await h.click('[data-model-picker="school"]');
      await page.waitForSelector('[data-model-option="work-model"]');
      check(!(await page.$('[data-model-option="personal-model"]')), "switching accounts of the same assistant refreshes its actual model catalog");
    },
  },

  {
    name: "agent-instances-manage",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {}, instanceUsage: { codex: { available: true, windows: [{ label: "Session", usedPercent: 23, resetsAt: 1793836800 }], reason: null } } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-agent-instance="codex"]');
      check((await page.$$(`${PANEL} [data-agent-instance]`)).length === 3, "each installed assistant has its own connection row");
      await h.click('[data-provider-configure="codex-cli"]');
      await page.waitForSelector(dialog);
      await page.waitForFunction(() => document.querySelector('[data-instance-usage]')?.textContent.includes("23% used"));
      check((await calls(page, "agent_instance_select")).length === 0, "opening a connection leaves the active provider unchanged");
      const usage = await page.$eval('[data-instance-usage]', (element) => element.innerText);
      check(usage.includes("Session") && usage.includes("23% used") && usage.includes("Resets"), "usage renders actual windows and a reset time", usage);
      await h.click(`${dialog} [data-instance-select]`);
      check((await calls(page, "agent_instance_select"))[0]?.id === "codex", "Use as default selects this exact connection");
      await h.click(`${dialog} [data-instance-signout]`);
      await page.waitForFunction(() => document.querySelector('[data-cli-sign-in-start]')?.textContent === "Sign in to Codex");
      check((await calls(page, "agent_instance_sign_out"))[0]?.id === "codex", "Sign out targets the selected connection");
      await h.click(`${dialog} [data-cli-sign-in-start]`);
      await page.waitForSelector('[data-cli-sign-in-outcome="signedIn"]');
      check((await calls(page, "agent_instance_sign_in"))[0]?.id === "codex", "browser sign-in targets the exact account home");
      await h.shot("account-and-usage");
    },
  },
  {
    name: "agent-instances-create",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await h.click('[data-agent-instance-add]');
      await page.waitForSelector(dialog);
      await page.select('[data-instance-cli]', "codex");
      await page.type('[data-instance-name]', "Codex · Work");
      await page.type('[data-instance-binary]', "/opt/company/bin/codex");
      await page.type('[data-instance-args]', "--config\nname=a value with spaces");
      await h.click('[data-instance-save]');
      await page.waitForSelector('[data-instance-select]');
      const saved = (await calls(page, "agent_instance_save"))[0]?.instance;
      check(saved.cli === "codex" && saved.name === "Codex · Work" && saved.binary === "/opt/company/bin/codex", "a named connection saves its assistant and executable", JSON.stringify(saved));
      check(saved.args.length === 2 && saved.args[1] === "name=a value with spaces", "arguments preserve spaces as literal argv entries", JSON.stringify(saved.args));
      check((await calls(page, "agent_instance_select")).length === 0, "creating a connection does not switch providers");
      await h.click('[data-instance-remove]');
      check((await calls(page, "agent_instance_remove")).length === 0, "Remove asks before changing saved connections");
      await h.click('[data-instance-remove-confirm]');
      await page.waitForFunction(() => !document.querySelector('[data-agent-instance-popup]'));
      check((await calls(page, "agent_instance_remove"))[0]?.id === saved.id, "Remove deletes only the custom connection");
    },
  },
  {
    name: "agent-instances-selected-error-route",
    sizes: [[1100, 720], [640, 480]],
    mock: {
      settings: { ...SETTINGS, backend: "claude-cli" }, threads: {},
      activeAgentInstances: { claude: "claude-work" },
      agentInstances: [
        { config: { id: "claude", cli: "claude", name: "Claude Code", binary: "", args: [] }, installed: true, loggedIn: true, account: null, plan: null, managedHome: false },
        { config: { id: "claude-work", cli: "claude", name: "Claude Work", binary: "", args: [] }, installed: true, loggedIn: false, account: null, plan: null, managedHome: true },
      ],
      sendError: { code: "notLoggedIn", message: "Claude Code is not signed in." },
    },
    async run(page, h) {
      await h.send("Review this project.");
      await page.waitForSelector('[data-error-action="settings"]');
      await h.click('[data-error-action="settings"]');
      await page.waitForSelector(dialog);
      check(await page.$eval('[data-instance-name]', (input) => input.value === "Claude Work"), "Fix sign-in opens the selected custom account instead of the built-in account");
      await h.click('[data-cli-sign-in-start]');
      await page.waitForSelector('[data-cli-sign-in-outcome="signedIn"]');
      check((await calls(page, "agent_instance_sign_in")).at(-1)?.id === "claude-work", "sign-in repairs the exact account that failed");
      await page.$$eval('[data-agent-instance-popup] [data-slot="dialog-footer"] button', (buttons) => buttons.find((button) => button.textContent === "Done").click());
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      check(await page.evaluate(() => document.activeElement?.matches('[data-error-action="settings"]')), "closing repair returns to its original error action");
    },
  },
  {
    name: "agent-instances-usage-race",
    sizes: [[1100, 720]],
    mock: {
      settings: SETTINGS, threads: {}, slow: { agent_instance_usage: 1600 },
      instanceUsage: {
        claude: { available: true, windows: [{ label: "Claude window", usedPercent: 81, resetsAt: null }], reason: null },
        codex: { available: true, windows: [{ label: "Codex window", usedPercent: 12, resetsAt: null }], reason: null },
      },
    },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
        window.__completedUsage = [];
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const result = await invoke(command, args);
          if (command === "agent_instance_usage") window.__completedUsage.push(args.id);
          return result;
        };
      });
      await h.click('[data-provider-configure="claude-cli"]');
      await page.waitForFunction(() => window.__calls.some(([command, args]) => command === "agent_instance_usage" && args.id === "claude"));
      await page.$$eval('[data-agent-instance-popup] [data-slot="dialog-footer"] button', (buttons) => buttons.find((button) => button.textContent === "Done").click());
      await page.waitForFunction(() => !document.querySelector('[data-agent-instance-popup]'));
      await page.evaluate(() => { window.__MOCK__.slow.agent_instance_usage = 0; });
      await h.click('[data-provider-configure="codex-cli"]');
      await page.waitForFunction(() => document.querySelector('[data-instance-usage]')?.textContent.includes("12% used"));
      await page.waitForFunction(() => window.__completedUsage.includes("claude"));
      const shown = await page.$eval('[data-instance-usage]', (usage) => usage.textContent);
      check(shown.includes("Codex window") && shown.includes("12% used") && !shown.includes("81%"), "a slow previous account cannot overwrite the current account’s usage", shown);
      check(await page.$eval('[aria-label="Refresh usage"]', (button) => !button.disabled), "only the latest usage request controls its loading state");
    },
  },
  {
    name: "agent-instances-status-race",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, clis: [{ id: "codex", name: "Codex", installed: true, loggedIn: false }] },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-provider-configure="codex-cli"]');
      await h.click('[data-provider-configure="codex-cli"]');
      await page.waitForSelector(dialog);
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
        let hold = true;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const result = await invoke(command, args);
          if (command === "agent_instances_list" && hold) {
            hold = false;
            await new Promise((resolve) => { window.__releaseOldStatus = () => { window.__oldStatusDelivered = true; resolve(); }; });
          }
          return result;
        };
      });
      await h.click('[aria-label="Refresh connection status"]');
      await page.waitForFunction(() => typeof window.__releaseOldStatus === "function");
      await h.click('[data-cli-sign-in-start]');
      await page.waitForSelector('[data-cli-sign-in-outcome="signedIn"]');
      await page.waitForFunction(() => document.querySelector('[data-cli-sign-in-start]')?.textContent === "Change account");
      await page.evaluate(() => window.__releaseOldStatus());
      await page.waitForFunction(() => window.__oldStatusDelivered === true);
      await h.idle();
      check(await page.$eval('[data-cli-sign-in-start]', (button) => button.textContent === "Change account"), "a late pre-login status response cannot undo the successful account state");
    },
  },
];
