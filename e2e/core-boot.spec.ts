import { expect, test } from "@playwright/test";
import { startCore } from "./core";

test("the core opens after one navigation runs out of browser socket buffers", async ({ page }) => {
  const core = await startCore({ script: { claude: true, steps: [] } });
  const goto = page.goto.bind(page);
  let attempts = 0;
  page.goto = (...args) => {
    if (++attempts === 1) return Promise.reject(new Error("page.goto: net::ERR_NO_BUFFER_SPACE"));
    return goto(...args);
  };
  try {
    await core.open(page);
    await expect(page.getByRole("navigation").first()).toBeVisible();
    expect(attempts).toBe(2);
  } finally { await core.stop(); }
});

test("the core surfaces repeated socket errors and other navigation failures", async ({ page }) => {
  const core = await startCore({ script: { claude: true, steps: [] } });
  let attempts = 0;
  page.goto = () => { attempts++; return Promise.reject(new Error("page.goto: net::ERR_NO_BUFFER_SPACE")); };
  try {
    await expect(core.open(page)).rejects.toThrow("net::ERR_NO_BUFFER_SPACE");
    expect(attempts).toBe(2);
    attempts = 0;
    page.goto = () => { attempts++; return Promise.reject(new Error("page.goto: net::ERR_CONNECTION_REFUSED")); };
    await expect(core.open(page)).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
    expect(attempts).toBe(1);
  } finally { await core.stop(); }
});
