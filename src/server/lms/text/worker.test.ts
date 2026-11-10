import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extract, pdfLayers } from "./index.ts";
import { testPdf } from "./test-pdfs.ts";

/**
 * The desktop app runs the text child as a worker thread (the core is an
 * Electron utility process and can't start Electron's binary as Node). This
 * runs the same extraction through the worker path with the built child.
 */
const root = path.resolve(import.meta.dirname, "../../../..");
const cache = path.join(root, "node_modules", ".cache", "phaethon-test");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-worker-"));

beforeAll(async () => {
  fs.mkdirSync(cache, { recursive: true });
  const out = path.join(cache, "text-child.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["src/server/lms/text/child.ts"],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    alias: { "#shared": path.join(root, "src/shared") },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "silent",
  });
  process.env.PHAETHON_TEXT_WORKER = "1";
  process.env.PHAETHON_TEXT_CHILD = out;
});

afterAll(() => {
  delete process.env.PHAETHON_TEXT_WORKER;
  delete process.env.PHAETHON_TEXT_CHILD;
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, data: Uint8Array | string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
};

describe("the text child as a worker thread", () => {
  it("reads a PDF's text and turns junk into an error", async () => {
    expect(await extract(file("w.pdf", testPdf("Week 3: Hash tables")))).toBe("## Page 1\n\nWeek 3: Hash tables");
    await expect(extract(file("junk.pdf", "%PDF-1.4 nothing else"))).rejects.toThrow(/^it couldn’t be read as a PDF/);
  });

  it("is stopped by a cancel", async () => {
    const stop = new AbortController();
    const p = pdfLayers(file("c.pdf", testPdf("Limits")), stop.signal);
    stop.abort();
    await expect(p).rejects.toThrow(/^cancelled$/);
  });
});
