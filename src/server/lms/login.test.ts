import { afterEach, describe, expect, it } from "vitest";
import type { HostCookie, HostEventBody, HostOp } from "#shared/host.ts";
import { setHost, type Host } from "../host.ts";
import { allowedNavigation, dataStoreId, partitionFor, setLoginTimingForTests, signIn, siteCookies } from "./login.ts";
import { html, serve, type FakeSite } from "./testing/fake-site.ts";
import { Site } from "./types.ts";

/** A desktop shell standing in for Electron's main process. */
class FakeHost implements Host {
  readonly available = true;
  ops: HostOp[] = [];
  jar: HostCookie[] = [];
  listeners = new Set<(e: HostEventBody) => void>();
  open = new Set<number>();
  next = 1;
  call<T>(op: HostOp): Promise<T> {
    this.ops.push(op);
    switch (op.op) {
      case "windowOpen": {
        const id = this.next++;
        this.open.add(id);
        return Promise.resolve(id as T);
      }
      case "windowCookies":
        if (!this.open.has(op.window)) return Promise.reject(new Error("That sign-in window is closed."));
        return Promise.resolve(this.jar.map((c) => ({ ...c })) as T);
      case "windowClose":
        if (this.open.delete(op.window)) this.emit({ kind: "windowClosed", window: op.window });
        return Promise.resolve(null as T);
      default:
        return Promise.resolve(null as T);
    }
  }
  on(listener: (e: HostEventBody) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: HostEventBody): void {
    for (const l of [...this.listeners]) l(e);
  }
  cookie(name: string, value: string, domain: string, secure = false): HostCookie {
    return { name, value, domain, path: "/", secure, httpOnly: true };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: FakeSite[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  setLoginTimingForTests(1500, 30 * 60 * 1000);
});

async function windowOpened(h: FakeHost): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const op = h.ops.find((o) => o.op === "windowOpen");
    if (op) return h.next - 1;
    await sleep(5);
  }
  throw new Error("no window opened");
}

describe("sign-in (ported from login.rs)", () => {
  it("only the site's cookies are kept", () => {
    const site = Site.create("canvas", "canvas.iu.edu");
    const jar = [
      { name: "canvas_session", value: "s1", domain: "canvas.iu.edu", secure: true },
      { name: "_csrf_token", value: "t", domain: ".canvas.iu.edu", secure: true },
      { name: "sso", value: "parent", domain: ".iu.edu", secure: true },
      { name: "sso", value: "child", domain: "canvas.iu.edu", secure: true },
      { name: "tracker", value: "x", domain: ".google.com", secure: false },
      { name: "evil", value: "x", domain: "notcanvas.iu.edu", secure: false },
      { name: "lookalike", value: "x", domain: "u.edu", secure: false },
      { name: "hostless", value: "x", domain: null, secure: false },
    ];
    expect(siteCookies(site, jar).map((c) => [c.name, c.value])).toEqual([
      ["canvas_session", "s1"],
      ["_csrf_token", "t"],
      ["sso", "child"],
    ]);
    expect(siteCookies(Site.forTest("canvas", "http://127.0.0.1:9"), [{ name: "s", value: "1", domain: "127.0.0.1", secure: true }])).toEqual([]);
  });

  it("the window goes to web pages only", () => {
    for (const ok of ["https://idp.iu.edu/login", "http://old.example.edu/", "about:blank", "about:srcdoc", "blob:https://idp.iu.edu/1f2e", "data:text/html,x"]) {
      expect(allowedNavigation(new URL(ok))).toBe(true);
    }
    for (const no of ["file:///etc/passwd", "tauri://localhost/", "ipc://localhost/x", "zoommtg://x", "javascript:alert(1)"]) {
      expect(allowedNavigation(new URL(no))).toBe(false);
    }
  });

  it("each vault has its own sign-in store", () => {
    const a = dataStoreId("default");
    expect(a).toEqual(dataStoreId("default"));
    expect(a).not.toEqual(dataStoreId("other"));
    expect(a[6] >> 4).toBe(4);
    expect(a[8] >> 6).toBe(2);
    expect(partitionFor("default")).toMatch(/^persist:lms-login-[0-9a-f]{32}$/);
  });

  it("signs in once the site's page has a session cookie, filling the CSRF token from the page", async () => {
    const s = await serve(() => html('<html><head><meta name="csrf-token" content="tok%3D"></head></html>'));
    servers.push(s);
    const site = Site.forTest("canvas", s.base);
    const h = new FakeHost();
    setHost(h);
    setLoginTimingForTests(20, 60_000);
    const done = signIn(site, "Sign in to IU", "persist:lms-login-x");
    const id = await windowOpened(h);
    expect(h.ops[0]).toEqual({ op: "windowOpen", url: `${s.base}/login`, title: "Sign in to IU", partition: "persist:lms-login-x", width: 960, height: 780 });
    // Still on the login page: not yet.
    h.jar = [h.cookie("canvas_session", "sess", "127.0.0.1")];
    h.emit({ kind: "windowNavigated", window: id, url: `${s.base}/login/canvas` });
    await sleep(80);
    // Past it, with a session (and a cookie for another site, which is dropped).
    h.jar.push(h.cookie("tracker", "x", ".google.com"));
    h.emit({ kind: "windowNavigated", window: id, url: `${s.base}/?login_success=1` });
    const cred = await done;
    expect(cred).toEqual({ cookies: [{ name: "canvas_session", value: "sess" }], csrf: "tok%3D" });
    expect(h.ops.some((o) => o.op === "windowClose" && o.window === id)).toBe(true);
    expect(s.log.length).toBe(1);
    expect(s.log[0].cookie).toBe("canvas_session=sess");
  });

  it("a CSRF cookie is used as it is, without asking the site", async () => {
    const site = Site.forTest("canvas", "http://127.0.0.1:9");
    const h = new FakeHost();
    setHost(h);
    setLoginTimingForTests(20, 60_000);
    const done = signIn(site, "t", "p");
    const id = await windowOpened(h);
    h.jar = [h.cookie("_normandy_session", "n", "127.0.0.1"), h.cookie("_csrf_token", "abc%2Bdef", "127.0.0.1")];
    h.emit({ kind: "windowNavigated", window: id, url: "http://127.0.0.1:9/" });
    expect(await done).toEqual({ cookies: [{ name: "_normandy_session", value: "n" }, { name: "_csrf_token", value: "abc%2Bdef" }], csrf: "abc+def" });
  });

  it("closing the window cancels, and only one window opens at a time", async () => {
    const site = Site.forTest("canvas", "http://127.0.0.1:9");
    const h = new FakeHost();
    setHost(h);
    setLoginTimingForTests(20, 60_000);
    const first = signIn(site, "t", "p");
    const id = await windowOpened(h);
    await expect(signIn(site, "t", "p")).rejects.toThrow("A sign-in window is already open. Finish signing in there, or close it.");
    await sleep(10);
    expect(h.ops.some((o) => o.op === "windowFocus" && o.window === id)).toBe(true);
    h.open.delete(id);
    h.emit({ kind: "windowClosed", window: id });
    await expect(first).rejects.toThrow("cancelled");
    // Free again afterwards.
    const again = signIn(site, "t", "p");
    const id2 = await (async () => {
      for (let i = 0; i < 200; i++) {
        if (h.ops.filter((o) => o.op === "windowOpen").length === 2) return h.next - 1;
        await sleep(5);
      }
      throw new Error("no second window");
    })();
    h.emit({ kind: "quitting" });
    await expect(again).rejects.toThrow("cancelled");
    expect(h.ops.some((o) => o.op === "windowClose" && o.window === id2)).toBe(true);
  });

  it("gives up after the time limit", async () => {
    const site = Site.forTest("canvas", "http://127.0.0.1:9");
    const h = new FakeHost();
    setHost(h);
    setLoginTimingForTests(10, 60);
    const done = signIn(site, "t", "p");
    const id = await windowOpened(h);
    h.emit({ kind: "windowNavigated", window: id, url: "http://127.0.0.1:9/login" });
    await expect(done).rejects.toThrow("cancelled");
    expect(h.ops.some((o) => o.op === "windowClose" && o.window === id)).toBe(true);
  });
});
