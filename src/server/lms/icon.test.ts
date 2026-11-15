import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, vaultRoot } from "../core/vault.ts";
import { fetchSiteIcon, siteIcon } from "./icon.ts";
import { save } from "./store.ts";

const env = tempHome();
let server: http.Server;
let origin: URL;
let hits: string[] = [];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

beforeAll(async () => {
  ensureVault();
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/x-icon" });
      res.end(PNG);
    } else if (req.url === "/apple-touch-icon.png" && req.headers.host?.includes("branded")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else if (req.url === "/favicon.png") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not an image</html>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  env.cleanup();
});

describe("a course site's icon", () => {
  it("takes the first image the origin serves and skips what isn't one", async () => {
    hits = [];
    const url = await fetchSiteIcon(origin);
    expect(url).toBe(`data:image/x-icon;base64,${PNG.toString("base64")}`);
    expect(hits).toEqual(["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.png", "/favicon.ico"]);
  });

  it("is null for a site with no icon, and never throws", async () => {
    const dead = new URL("http://127.0.0.1:9/");
    expect(await fetchSiteIcon(dead)).toBeNull();
    expect(await fetchSiteIcon(origin, async () => new Response("x", { status: 500 }))).toBeNull();
  });

  it("remembers a connection's icon for a week, misses too", async () => {
    save(vaultRoot(), {
      connections: [
        { id: "canvas-x", kind: "canvas", address: origin.href, signedIn: false, courses: {} },
        { id: "moodle-y", kind: "moodle", address: "https://127.0.0.1:9", signedIn: false, courses: {} },
      ],
    });
    hits = [];
    const first = await siteIcon("canvas-x");
    expect(first.dataUrl).toMatch(/^data:image\/x-icon;base64,/);
    const n = hits.length;
    expect(await siteIcon("canvas-x")).toEqual(first);
    expect(hits.length).toBe(n);
    // After a week it is fetched again.
    hits = [];
    await siteIcon("canvas-x", undefined, Date.now() + 8 * 86_400_000);
    expect(hits.length).toBeGreaterThan(0);
    expect(await siteIcon("moodle-y")).toEqual({ dataUrl: null });
    await expect(async () => siteIcon("nope")).rejects.toThrow("isn’t connected");
  });
});
