import { expect, test, type Page } from "@playwright/test";

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function openSidebar(page: Page) {
  const opener = page.getByRole("button", { name: "Open sidebar", exact: true });
  if (await opener.isVisible()) await opener.click();
}

test("staff signs in, examines a trace, filters events, exports, and signs out", async ({ page }, testInfo) => {
  let authenticated = false;
  let loginFailed = false;
  const seen: string[] = [];
  const item = { id: "c1e5a751-24c5-4e06-a5c7-11290b652b93", category: "traces", event: "chat_trace", receivedAt: "2026-11-19T12:00:00.000Z", sentAt: "2026-11-19T12:00:00.000Z", appVersion: "0.3.1", platform: "darwin" };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === "/api/login") {
      const body = route.request().postDataJSON();
      if (body.password !== "test-session-password") { loginFailed = true; return json({}, 401); }
      expect(body.email).toBe("tester@example.test"); authenticated = true;
      return json({ email: "tester@example.test" });
    }
    if (!authenticated) return json({}, 401);
    if (url.pathname === "/api/logout") { authenticated = false; return route.fulfill({ status: 204 }); }
    if (url.pathname === "/api/session") return json({ email: "tester@example.test" });
    if (url.pathname === "/api/overview") return json({ totals: { usage: 120, diagnostics: 40, reports: 2, traces: 6 }, days: [{ day: "2026-11-17", count: 42 }, { day: "2026-11-18", count: 73 }, { day: "2026-11-19", count: 53 }], events: [{ event: "app_opened", count: 120 }, { event: "turn_completed", count: 40 }], outcomes: [{ outcome: "completed", count: 38 }, { outcome: "failed", count: 2 }] });
    if (url.pathname === "/api/events") return json({ items: !url.searchParams.get("category") || url.searchParams.get("category") === "traces" ? [item] : [], nextCursor: null });
    if (url.pathname.startsWith("/api/events/")) return json({ envelope: { id: item.id }, payload: { category: "traces", event: "chat_trace", data: { backend: "phaethon", messages: [{ role: "user", text: "Help me plan a study session. Contact [email]." }, { role: "assistant", text: "Start with a short review, then practice." }] } }, receivedAt: item.receivedAt, verification: "self-signed" });
    if (url.pathname === "/api/export") return route.fulfill({ contentType: "application/x-ndjson", headers: url.searchParams.has("before") ? {} : { "X-Next-Cursor": "page-two" }, body: JSON.stringify(item) + "\n" });
    return json({}, 404);
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sign-in.png") });
  await page.getByLabel("Email or username", { exact: true }).fill("tester@example.test");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("weren’t recognized");
  expect(loginFailed).toBe(true);
  await page.getByLabel("Password", { exact: true }).fill("test-session-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Telemetry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Staff", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Chat trace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Event detail" })).toContainText("Contact [email]");
  await page.getByText("Raw record", { exact: true }).click();
  await expect(page.locator("pre")).toContainText("self-signed");
  await page.screenshot({ path: testInfo.outputPath("explorer.png"), fullPage: true, animations: "disabled" });
  await choose(page, "Event category", "Usage");
  await expect(page.getByText("No shared events in this period.")).toBeVisible();
  await choose(page, "Event category", "Chat traces");
  await choose(page, "Time period", "Last 30 days");
  await expect(page.getByRole("button", { name: "Chat trace", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export NDJSON" }).click();
  expect((await download).suggestedFilename()).toBe("phaethon-telemetry-traces-30d.ndjson");
  expect(seen).toContain("/api/export?days=30&category=traces");
  expect(seen).toContain("/api/export?days=30&category=traces&before=page-two");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-dark.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await openSidebar(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Event detail" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("super admin manages accounts and reviews access changes", async ({ page }, testInfo) => {
  const members = [{ id: "owner", email: "owner@example.test", username: "owner", role: "owner", disabled: false }];
  const audit: { id: string; actorEmail: string; targetEmail: string; action: string; createdAt: string }[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: "owner@example.test", role: "owner" } });
    if (url.pathname === "/api/overview") return route.fulfill({ json: { totals: {}, days: [], events: [], outcomes: [] } });
    if (url.pathname === "/api/events") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.pathname === "/api/staff/audit") return route.fulfill({ json: { items: audit } });
    if (url.pathname === "/api/staff" && method === "GET") return route.fulfill({ json: { items: members } });
    if (url.pathname === "/api/staff" && method === "POST") {
      const { password, ...member } = route.request().postDataJSON();
      expect(password.length).toBeGreaterThanOrEqual(14);
      members.push({ ...member, id: "viewer", disabled: false });
      audit.unshift({ id: "create", actorEmail: "owner@example.test", targetEmail: member.email, action: "created", createdAt: "2026-11-19T12:00:00.000Z" });
      return route.fulfill({ status: 201, json: { ok: true } });
    }
    if (url.pathname === "/api/staff/owner" && method === "PATCH") return route.fulfill({ status: 409, json: { error: "Keep at least one active super admin." } });
    if (url.pathname === "/api/staff/viewer" && method === "PATCH") {
      Object.assign(members[1], route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Staff", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Staff access", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const editor = page.getByRole("region", { name: "Account editor" });
  await editor.getByLabel("Email", { exact: true }).fill("viewer@example.test");
  await editor.getByLabel("Username", { exact: true }).fill("viewer");
  await editor.getByLabel("Password", { exact: true }).fill("local-test-password");
  await editor.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByRole("button", { name: "Manage viewer@example.test" })).toBeVisible();
  await expect(page.getByText("owner@example.test · created · viewer@example.test")).toBeVisible();
  await page.getByRole("button", { name: "Manage viewer@example.test" }).click();
  await editor.getByRole("switch", { name: "Allow sign-in" }).uncheck();
  await editor.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByRole("row").filter({ hasText: "viewer@example.test" })).toContainText("Disabled");
  await page.getByRole("button", { name: "Manage owner@example.test" }).click();
  await choose(page, "Role", "Viewer");
  await editor.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByRole("alert")).toContainText("Keep at least one active super admin");
  await page.screenshot({ path: testInfo.outputPath("staff-access.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("staff-mobile-dark.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an expired session clears the authenticated explorer", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: route.request().url().endsWith("/session") ? 200 : 401, json: { email: "tester@example.test" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Event explorer" })).toHaveCount(0);
});

test("changing category cancels stale pagination and signing out cancels an export", async ({ page }) => {
  const usage = { id: "one", category: "usage", event: "app_opened", receivedAt: "2026-11-19T12:00:00.000Z", appVersion: "0.3.1", platform: "darwin" };
  const trace = { ...usage, id: "two", category: "traces", event: "chat_trace" };
  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  let releaseExport!: () => void;
  const exportGate = new Promise<void>((resolve) => { releaseExport = resolve; });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: "tester@example.test" } });
    if (url.pathname === "/api/logout") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/overview") return route.fulfill({ json: { totals: { usage: 1, traces: 1 }, days: [], events: [], outcomes: [] } });
    if (url.pathname === "/api/export") {
      await exportGate;
      return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(trace) }).catch(() => {});
    }
    if (url.pathname === "/api/events") {
      if (url.searchParams.has("before")) {
        await pageGate;
        return route.fulfill({ json: { items: [trace], nextCursor: null } }).catch(() => {});
      }
      return route.fulfill({ json: { items: [usage], nextCursor: url.searchParams.get("category") ? null : "old-page" } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  const paginating = page.waitForRequest((r) => r.url().includes("before=old-page"));
  await page.getByRole("button", { name: "Load more" }).click();
  await paginating;
  await choose(page, "Event category", "Usage");
  await expect(page.getByRole("combobox", { name: "Event category", exact: true })).toContainText("Usage");
  releasePage();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "App opened", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat trace", exact: true })).toHaveCount(0);
  const exporting = page.waitForRequest((r) => r.url().includes("/api/export"));
  await page.getByRole("button", { name: "Export NDJSON" }).click();
  await exporting;
  await openSidebar(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  releaseExport();
  await page.waitForLoadState("networkidle");
  expect(downloads).toBe(0);
});

test("sign-in has placeholders, stable session loading, and one pending submission", async ({ page }, testInfo) => {
  let releaseSession!: () => void;
  let releaseLogin!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  let submissions = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") { await sessionGate; return route.fulfill({ status: 401 }); }
    if (url.pathname === "/api/login") { submissions++; await loginGate; return route.fulfill({ status: 401 }); }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Checking your session" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("session-skeleton.png"), animations: "disabled" });
  releaseSession();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("header, nav")).toHaveCount(0);
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByPlaceholder("you@example.com or username").fill("teammate");
  await page.getByPlaceholder("Enter your password").fill("sample-password");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({ path: testInfo.outputPath("sign-in-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("sign-in-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("sign-in-mobile.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await submit.click();
  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(submit).toBeDisabled();
  await expect(page.getByLabel("Email or username", { exact: true })).toBeDisabled();
  await page.getByLabel("Password", { exact: true }).press("Enter");
  expect(submissions).toBe(1);
  releaseLogin();
  await expect(page.getByRole("alert")).toContainText("weren’t recognized");
  await expect(submit).toBeEnabled();
});

test("overview uses skeletons, custom menus and sidebar preferences", async ({ page }, testInfo) => {
  let releaseOverview!: () => void;
  const gate = new Promise<void>((resolve) => { releaseOverview = resolve; });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: "owner@example.test", role: "owner" } });
    if (url.pathname === "/api/overview") { await gate; return route.fulfill({ json: { totals: { usage: 1642, diagnostics: 827, reports: 23, traces: 104 }, days: [{ day: "Nov 14", count: 120 }, { day: "Nov 15", count: 203 }, { day: "Nov 16", count: 184 }, { day: "Nov 17", count: 289 }, { day: "Nov 18", count: 241 }, { day: "Nov 19", count: 324 }], events: [{ event: "app_opened", count: 642 }, { event: "view_opened", count: 527 }, { event: "file_opened", count: 473 }], outcomes: [{ outcome: "completed", count: 804 }, { outcome: "failed", count: 23 }] } }); }
    if (url.pathname === "/api/events") return route.fulfill({ json: { items: [{ id: "sample", category: "usage", event: "app_opened", receivedAt: "2026-11-19T12:00:00.000Z", appVersion: "0.3.2", platform: "darwin" }], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Loading telemetry", exact: true })).toBeVisible();
  await expect(page.getByText("No shared events in this period.")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("overview-skeleton.png"), animations: "disabled" });
  releaseOverview();
  await expect(page.getByRole("button", { name: "Usage 1,642" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("overview.png"), animations: "disabled" });
  await page.getByRole("combobox", { name: "Time period" }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("custom-menu.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
  await choose(page, "Theme", "Dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toContainText("Dark");
  await page.screenshot({ path: testInfo.outputPath("preferences.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  await openSidebar(page);
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-sidebar.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeFocused();
});

test("staff retains cached rows across navigation and waits for confirmed mutations", async ({ page }, testInfo) => {
  const member = { id: "owner", email: "owner@example.test", username: "owner", role: "owner", disabled: false };
  let staffGate: Promise<void> = Promise.resolve();
  let auditGate: Promise<void> = Promise.resolve();
  let releaseStaff!: () => void;
  let releaseAudit!: () => void;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let saves = 0;
  let staffReads = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: member.email, role: "owner" } });
    if (url.pathname === "/api/overview") return route.fulfill({ json: { totals: {}, days: [], events: [], outcomes: [] } });
    if (url.pathname === "/api/events") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.pathname === "/api/staff" && route.request().method() === "GET") { staffReads++; await staffGate; return route.fulfill({ json: { items: [member] } }); }
    if (url.pathname === "/api/staff/audit") { await auditGate; return route.fulfill({ json: { items: [] } }); }
    if (url.pathname === "/api/staff/owner") { saves++; await saveGate; Object.assign(member, route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  staffGate = new Promise<void>((resolve) => { releaseStaff = resolve; });
  auditGate = new Promise<void>((resolve) => { releaseAudit = resolve; });
  await page.getByRole("button", { name: "Staff", exact: true }).click();
  await expect(page.getByRole("status", { name: "Loading staff", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading access changes", exact: true })).toBeVisible();
  await expect(page.getByText("No access changes yet.")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("staff-skeleton.png"), animations: "disabled" });
  releaseStaff(); releaseAudit();
  await expect(page.getByRole("button", { name: `Manage ${member.email}` })).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  staffGate = new Promise<void>((resolve) => { releaseStaff = resolve; });
  const readsBefore = staffReads;
  await page.getByRole("button", { name: "Staff", exact: true }).click();
  await expect.poll(() => staffReads).toBeGreaterThan(readsBefore);
  await expect(page.getByRole("button", { name: `Manage ${member.email}` })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading staff", exact: true })).toHaveCount(0);
  releaseStaff();
  await page.getByRole("button", { name: `Manage ${member.email}` }).click();
  const editor = page.getByRole("region", { name: "Account editor" });
  await editor.getByLabel("Username", { exact: true }).fill("renamed");
  const save = editor.getByRole("button", { name: "Save account", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("row").filter({ hasText: member.email })).toContainText("owner");
  expect(saves).toBe(1);
  releaseSave();
  await expect(page.getByRole("status")).toContainText(["Account updated."]);
  await expect(page.getByRole("row").filter({ hasText: member.email })).toContainText("renamed");
  await expect(editor).toHaveCount(0);
});

test("saved appearance controls sign-in art and session failures replace skeletons", async ({ page }, testInfo) => {
  let failSession = true;
  await page.addInitScript(() => localStorage.setItem("phaethon.telemetry.appearance", "dark"));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("**/api/session", (route) => route.fulfill({ status: failSession ? 500 : 401 }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Couldn’t open the console", exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Checking your session" })).toHaveCount(0);
  failSession = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.locator(".telemetry-art").evaluate((el) => getComputedStyle(el).getPropertyValue("--art-hero-0").trim())).toBe("oklch(17% 0.035 262)");
  await page.screenshot({ path: testInfo.outputPath("sign-in-saved-dark-light-os.png"), animations: "disabled" });
});

test("settings expose sign-out errors and preserve sidebar state across same-layout resizes", async ({ page }) => {
  let logoutFails = true;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: "owner@example.test", role: "owner" } });
    if (url.pathname === "/api/logout") return route.fulfill({ status: logoutFails ? 500 : 204 });
    if (url.pathname === "/api/overview") return route.fulfill({ json: { totals: {}, days: [], events: [], outcomes: [] } });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/#preferences");
  await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await skip.press("Enter");
  await expect(page.locator("#console-content")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("#preferences");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t sign out. Try again.");
  await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
  await page.setViewportSize({ width: 1200, height: 820 });
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-slot="sidebar-wrapper"]')).toHaveAttribute("data-sidebar-floating", "true");
  await openSidebar(page);
  await page.setViewportSize({ width: 390, height: 750 });
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preferences", exact: true })).toBeVisible();
  logoutFails = false;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

test("event filters do not affect overview and failed reads do not look empty", async ({ page }) => {
  let readsFail = false;
  const item = { id: "one", category: "usage", event: "app_opened", receivedAt: "2026-11-19T12:00:00.000Z", appVersion: "0.3.2", platform: "darwin" };
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: "viewer@example.test", role: "viewer" } });
    if (readsFail) return route.fulfill({ status: 500 });
    if (url.pathname === "/api/overview") return route.fulfill({ json: { totals: { usage: 1 }, days: [], events: [], outcomes: [] } });
    if (url.pathname === "/api/events") return route.fulfill({ json: { items: url.searchParams.has("category") ? [] : [item], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Usage 1", exact: true }).click();
  await choose(page, "Event category", "Chat traces");
  await page.getByRole("searchbox", { name: "Filter loaded events" }).fill("unmatched");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("button", { name: "App opened", exact: true })).toBeVisible();
  await expect(page.getByText("No loaded events match this filter.")).toHaveCount(0);
  readsFail = true;
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("No shared events in this period.")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("forbidden staff revalidation clears privileged cached data", async ({ page }) => {
  let forbidden = false;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { email: "owner@example.test", role: "owner" } });
    if (url.pathname === "/api/overview") return route.fulfill({ json: { totals: {}, days: [], events: [], outcomes: [] } });
    if (url.pathname === "/api/staff" && !forbidden) return route.fulfill({ json: { items: [{ id: "owner", email: "private-staff@example.test", username: "owner", role: "owner", disabled: false }] } });
    if (url.pathname.startsWith("/api/staff") && forbidden) return route.fulfill({ status: 403, json: { error: "Super admin access required." } });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/#staff");
  await expect(page.getByRole("button", { name: "Manage private-staff@example.test" })).toBeVisible();
  forbidden = true;
  await page.getByRole("button", { name: "Refresh staff", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("private-staff@example.test", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).some((value) => String(value).includes("private-staff@example.test")))).toBe(false);
});
