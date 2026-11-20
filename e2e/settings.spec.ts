import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

/** Settings against the real core: the theme is saved in the vault, a bad key gets a field error, Esc goes back. */

let core: Core | undefined;

/**
 * ⌘, opens Settings. On a slow runner the first press can land before the shell's shortcuts listen, and ⌘, toggles,
 * so press again only while Settings is still closed (its title slot shows as soon as it opens, before its page loads).
 */
async function openSettings(page: import("@playwright/test").Page) {
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(async () => {
    if (await page.locator('[data-slot="settings-title"]').isHidden()) await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test("the theme is saved in the vault and applied", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: /Dark/ }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const settings = JSON.parse(fs.readFileSync(path.join(core.home, "Phaethon", "default", ".phaethon", "settings.json"), "utf8"));
  expect(settings.appearance.theme).toBe("dark");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
});

test("a key in the wrong format is refused under the field and never saved", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await openSettings(page);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: /^AI & Models/ }).click();
  // Expand Claude and switch to the API key tab.
  await page.getByTestId("models-brands").getByRole("button", { name: /^Claude/ }).click();
  await page.getByRole("tab", { name: /^API key/ }).click();
  const key = page.getByPlaceholder("sk-ant-…");
  await key.fill("not-a-key");
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
});

test("AI & Models lists every service without a menu, and a row opens in place to set it up", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await openSettings(page);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: /^AI & Models/ }).click();
  // Every service is a visible row: the big three, more services, local models and a custom server.
  for (const [group, names] of [
    ["models-brands", ["Claude", "ChatGPT", "Google Gemini"]],
    ["models-cloud", ["OpenRouter", "Groq", "Together AI", "Mistral", "DeepSeek", "xAI"]],
    ["models-local", ["Ollama", "LM Studio"]],
    ["models-custom", ["Your own server"]],
  ] as const) {
    for (const name of names) await expect(page.getByTestId(group).getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /^Add (service|provider)/ })).toHaveCount(0);
  // A service that isn't set up says so, and opens to its key.
  const groq = page.getByTestId("models-cloud").getByRole("button", { name: /^Groq/ });
  await expect(groq).toContainText("Set up");
  await groq.click();
  await expect(groq).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByPlaceholder(/gsk_|Paste your key/)).toBeVisible();
});

test("IU REALLMS takes a sign-in token, shows when it expires, and lists its models", async ({ page }) => {
  // A stand-in for reallms.rescloud.iu.edu/api/v1: /auths/ answers 200 only to the right token.
  const http = await import("node:http");
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = (days: number) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64({ id: "x".repeat(260), exp: Math.floor(Date.now() / 1000) + days * 86_400 + 3600 })}.${"s".repeat(43)}`;
  const good = token(3);
  expect(good.length).toBeGreaterThan(400);
  const server = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${good}`;
    res.setHeader("content-type", "application/json");
    if (!ok) return res.writeHead(401).end(JSON.stringify({ detail: "Your session has expired or the token is invalid. Please sign in again." }));
    if (req.url === "/api/v1/auths/") return res.end(JSON.stringify({ id: "u", token: good }));
    if (req.url === "/api/v1/models") return res.end(JSON.stringify({ data: [{ id: "gemma-4-31B-it", name: "Gemma4 31B IT", info: {}, tags: [] }, { id: "glm-5.3-flash", name: "GLM 5.3 Flash" }] }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    core = await startCore({ env: { PHAETHON_REALLMS_BASE_URL: `http://127.0.0.1:${port}/api/v1` } });
    await core.open(page);
    await openSettings(page);
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: /^AI & Models/ }).click();
    const row = page.getByTestId("models-cloud").getByRole("button", { name: /^IU REALLMS/ });
    await expect(row).toContainText("IU sign-in");
    await row.click();
    await expect(page.getByRole("link", { name: "Sign in at reallms.rescloud.iu.edu" })).toHaveAttribute("href", "https://reallms.rescloud.iu.edu");
    await expect(page.getByText(/copy the token from Application › Local Storage/)).toBeVisible();
    const key = page.getByPlaceholder("Paste your key");
    // An expired token is refused before anything is sent.
    await key.fill(token(-2));
    await page.getByRole("button", { name: "Check and save" }).click();
    await expect(page.getByText(/Your REALLMS token has expired \(they last 7 days\)/)).toBeVisible();
    // A live token that the server rejects.
    await key.fill(token(5));
    await page.getByRole("button", { name: "Check and save" }).click();
    await expect(page.getByText(/REALLMS didn’t accept this token/)).toBeVisible();
    // The real one: saved, with its expiry beside it, and the model list opens.
    await key.fill(good);
    await page.getByRole("button", { name: "Check and save" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.getByText("Expires in 3 days")).toBeVisible();
    await page.getByRole("button", { name: "Choose a model", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "IU REALLMS models" }).getByRole("option", { name: /Gemma4 31B IT/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("reallms.png") });
  } finally {
    server.close();
  }
});
