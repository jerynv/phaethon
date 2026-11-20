import { expect, test } from "@playwright/test";

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
  await page.getByLabel("Email", { exact: true }).fill("tester@example.test");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("wasn’t recognized");
  expect(loginFailed).toBe(true);
  await page.getByLabel("Password", { exact: true }).fill("test-session-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Telemetry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Staff", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Chat trace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Event detail" })).toContainText("Contact [email]");
  await page.getByText("Raw record", { exact: true }).click();
  await expect(page.locator("pre")).toContainText("self-signed");
  await page.screenshot({ path: testInfo.outputPath("explorer.png"), fullPage: true });
  await page.getByLabel("Event category", { exact: true }).selectOption("usage");
  await expect(page.getByText("No shared events in this period.")).toBeVisible();
  await page.getByLabel("Event category", { exact: true }).selectOption("traces");
  await page.getByLabel("Time period", { exact: true }).selectOption("30");
  await expect(page.getByRole("button", { name: "Chat trace", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export NDJSON" }).click();
  expect((await download).suggestedFilename()).toBe("phaethon-telemetry-traces-30d.ndjson");
  expect(seen).toContain("/api/export?days=30&category=traces");
  expect(seen).toContain("/api/export?days=30&category=traces&before=page-two");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("mobile-dark.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
  await editor.getByLabel("Role", { exact: true }).selectOption("viewer");
  await editor.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByRole("alert")).toContainText("Keep at least one active super admin");
  await page.screenshot({ path: testInfo.outputPath("staff-access.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
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
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  const paginating = page.waitForRequest((r) => r.url().includes("before=old-page"));
  await page.getByRole("button", { name: "Load more" }).click();
  await paginating;
  await page.getByRole("button", { name: /^Usage 1$/ }).click();
  await expect(page.getByLabel("Event category", { exact: true })).toHaveValue("usage");
  releasePage();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "App opened", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat trace", exact: true })).toHaveCount(0);
  const exporting = page.waitForRequest((r) => r.url().includes("/api/export"));
  await page.getByRole("button", { name: "Export NDJSON" }).click();
  await exporting;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  releaseExport();
  await page.waitForLoadState("networkidle");
  expect(downloads).toBe(0);
});
