import { PANEL, SETTINGS, check, openSettings } from "../audit-fixtures.mjs";

const instances = [
  { config: { id: "claude", cli: "claude", name: "Claude Code", binary: "", args: [] }, installed: true, loggedIn: true, account: "Personal", plan: "Pro", managedHome: false },
  { config: { id: "codex", cli: "codex", name: "Codex", binary: "", args: [] }, installed: true, loggedIn: true, account: "Personal", plan: "Plus", managedHome: true },
  { config: { id: "codex-work", cli: "codex", name: "Codex Work", binary: "/opt/company/codex", args: ["--config", "name=a value"] }, installed: true, loggedIn: true, account: "Work", plan: "Team", managedHome: true },
  { config: { id: "gemini", cli: "gemini", name: "Gemini CLI", binary: "", args: [] }, installed: true, loggedIn: true, account: null, plan: null, managedHome: true },
];
const fixture = { settings: { ...SETTINGS, backend: "codex-cli", hasAnthropicKey: false }, threads: {}, agentInstances: instances };
const calls = (page, command) => page.evaluate((command) => window.__calls.filter(([name]) => name === command).map(([, args]) => args), command);

export default [
  {
    name: "providers-r3-master-detail",
    sizes: [[1100, 720], [640, 480]],
    mock: fixture,
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-agent-instance="codex-work"]');
      check(!await page.$$eval(`${PANEL} h4`, (headings) => headings.some((heading) => heading.textContent === "API providers")), "unconfigured API services do not leave an empty section heading");
      await h.click('[data-agent-instance="codex-work"]');
      await page.waitForFunction(() => document.querySelector('[data-instance-name]')?.value === "Codex Work");
      check(await page.$$eval('[role="dialog"]', (dialogs) => dialogs.filter((dialog) => dialog.getClientRects().length > 0).length === 1), "existing connections use the inline T3 detail panel rather than another modal");
      check((await calls(page, "agent_instance_select")).length === 0 && (await calls(page, "agent_instance_usage")).length === 0, "managing an account neither activates it nor loads usage");
      const presentation = await page.$eval('[data-agent-instance="codex-work"]', (row) => ({ weight: getComputedStyle(row.querySelector('span.text-sm')).fontWeight, shadow: getComputedStyle(row).boxShadow, border: getComputedStyle(row).borderBottomWidth }));
      check(Number(presentation.weight) <= 500 && presentation.shadow === "none" && presentation.border === "0px", "connection rows use restrained type without fake hairline shadows", JSON.stringify(presentation));
      await page.$$eval('[data-provider-detail] summary', (items) => items.find((item) => item.textContent.includes("Launch options")).click());
      check(await page.$eval('[data-instance-binary]', (input) => input.value === "/opt/company/codex"), "custom executable is visible in the selected connection");
      check(await page.$eval('[data-instance-args]', (input) => input.value.includes("name=a value")), "literal launch arguments belong to the selected account");
      await h.shot("provider-detail");
      if (await page.$eval('.provider-detail-back', (button) => getComputedStyle(button).display !== "none")) {
        await h.click('.provider-detail-back');
        check(await page.$eval('[data-agent-instance="codex"]', (row) => row.getClientRects().length > 0), "narrow Back returns to the complete account list");
      }
      await h.click('[data-provider-add]');
      await h.click('[data-provider-catalog-select="claude-cli"]');
      await page.waitForSelector('[role="dialog"] [data-instance-cli] [role="combobox"]');
      check(!(await page.$('[data-instance-cli] select')), "new connection assistant choices use Vic's actual Select");
      await h.click('[data-instance-cli] [role="combobox"]');
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      await page.type('[data-instance-name]', "Codex Research");
      await page.$$eval('[role="dialog"] summary', (items) => items.find((item) => item.textContent.includes("Launch options")).click());
      await page.type('[data-instance-binary]', "/opt/research/codex");
      await page.type('[data-instance-args]', "--config\nname=a value with spaces");
      await h.click('[data-instance-save]');
      await page.waitForFunction(() => window.__calls.some(([name]) => name === "agent_instance_save"));
      const saved = (await calls(page, "agent_instance_save")).at(-1)?.instance;
      check(saved.cli === "codex" && saved.name === "Codex Research" && saved.args[1] === "name=a value with spaces", "additional accounts save their actual CLI and literal argv", JSON.stringify(saved));
      check((await calls(page, "agent_instance_select")).length === 0, "adding an account preserves the active connection");
    },
  },
  {
    name: "providers-r3-system-account",
    sizes: [[1100, 720], [640, 480]],
    mock: { ...fixture, agentInstances: [...instances, { config: { id: "codex-system", cli: "codex", name: "Codex · System", binary: "", args: [] }, installed: true, loggedIn: true, account: "System account", plan: "Plus", managedHome: false, source: "system", readOnly: true }] },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await h.click('[data-agent-instance="codex-system"]');
      await page.waitForFunction(() => document.querySelector('[data-provider-detail]')?.textContent.includes("System account"));
      const detail = await page.$eval('[data-provider-detail]', (element) => ({ name: !!element.querySelector('[data-instance-name]'), args: !!element.querySelector('[data-instance-args]'), save: !!element.querySelector('[data-instance-save]'), remove: !!element.querySelector('[data-instance-remove]'), auth: !!element.querySelector('[data-cli-sign-in-start], [data-instance-signout]'), source: element.textContent.includes("System CLI") }));
      check(!detail.name && !detail.args && !detail.save && !detail.remove && !detail.auth && detail.source, "system CLI account is clearly labelled and does not expose mutation controls", JSON.stringify(detail));
      await h.click('[data-instance-select]');
      check((await calls(page, "agent_instance_select")).at(-1)?.id === "codex-system", "Use as default selects the exact existing system account");
      check((await calls(page, "agent_instance_save")).length === 0 && (await calls(page, "agent_instance_sign_out")).length === 0, "selecting system account neither rewrites its config nor signs it out");
    },
  },
  {
    name: "providers-r3-all-usage",
    sizes: [[1100, 720], [640, 480]],
    mock: { ...fixture, instanceUsage: {
      claude: { available: true, windows: [{ label: "Session", usedPercent: 81, resetsAt: null }], reason: null },
      codex: { available: true, windows: [{ label: "Weekly", usedPercent: 0, resetsAt: 1793836800 }], reason: null },
      "codex-work": { available: true, windows: [{ label: "Monthly", usedPercent: 42, resetsAt: null }], reason: null },
      gemini: { available: false, windows: [], reason: "Usage not reported." },
    } },
    async run(page, h) {
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
        window.__usageConcurrency = 0; window.__usageMaxConcurrency = 0;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if (command !== "agent_instance_usage") return invoke(command, args);
          window.__usageConcurrency++; window.__usageMaxConcurrency = Math.max(window.__usageMaxConcurrency, window.__usageConcurrency);
          try { const result = await invoke(command, args); await new Promise((resolve) => setTimeout(resolve, 100)); return result; }
          finally { window.__usageConcurrency--; }
        };
        window.dispatchEvent(new CustomEvent("phaethon:open-usage"));
      });
      await page.waitForFunction(() => document.querySelector('[data-usage-account="codex-work"]')?.textContent.includes("42% used"));
      await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh usage"]')?.disabled);
      const view = await page.$eval('[data-usage-dialog]', (dialog) => ({ text: dialog.textContent, accounts: dialog.querySelectorAll('[data-usage-account]').length, dropdown: !!dialog.querySelector('[role="combobox"]'), width: dialog.getBoundingClientRect().width, viewport: innerWidth }));
      check(view.accounts === 4 && !view.dropdown && view.text.includes("81% used") && view.text.includes("0% used") && view.text.includes("42% used"), "all account limits appear together without an account dropdown", JSON.stringify(view));
      check(view.text.includes("Monthly") && view.text.includes("Usage not reported."), "actual duration labels and unavailable limits retain their meaning");
      check(await page.evaluate(() => window.__usageMaxConcurrency <= 2), "all-account probes have a bounded concurrency of two");
      check(view.width < view.viewport, "the all-account usage view remains bounded at narrow widths");
      await h.shot("all-usage");
    },
  },
];
