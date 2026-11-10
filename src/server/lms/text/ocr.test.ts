import { describe, expect, it } from "vitest";
import { find, run } from "./engine.ts";
import { supervise } from "./ocr.ts";

const sh = (script: string) => (left: number[]) => ({ cmd: "/bin/sh", args: ["-c", script, "sh", ...left.map(String)] });

describe.skipIf(process.platform === "win32")("text recognition supervisor (ported from ocr.rs)", () => {
  it("every page answered once", async () => {
    const r = await supervise(sh('for p in "$@"; do echo "{\\"page\\":$p,\\"text\\":\\"page $p\\"}"; done'), [2, 5], 5000, 20000);
    expect(r.get(2)).toEqual({ text: "page 2" });
    expect(r.get(5)).toEqual({ text: "page 5" });
    expect(r.size).toBe(2);
  });

  it("a slow page is given up and the rest still done", async () => {
    const script = 'for p in "$@"; do if [ "$p" = 3 ]; then sleep 30; fi; echo "{\\"page\\":$p,\\"text\\":\\"ok $p\\"}"; done';
    const started = Date.now();
    const r = await supervise(sh(script), [1, 3, 4], 700, 20000);
    expect(r.get(1)).toEqual({ text: "ok 1" });
    expect(r.get(3)).toEqual({ failed: "recognising its text took too long" });
    expect(r.get(4)).toEqual({ text: "ok 4" });
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("a stop kills the recogniser at once", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    const r = await supervise(sh(`echo '{"page":1,"text":"one"}'; sleep 30; echo '{"page":2,"text":"two"}'`), [1, 2], 60000, 600000, stop.signal);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.get(1)).toEqual({ text: "one" });
    expect(r.get(2)).toEqual({ failed: "the import was cancelled" });
  });

  it("a crash marks that page and the file limit ends it", async () => {
    const crash = 'for p in "$@"; do if [ "$p" = 2 ]; then kill -9 $$; fi; echo "{\\"page\\":$p,\\"text\\":\\"\\"}"; done';
    let r = await supervise(sh(crash), [1, 2, 3], 5000, 20000);
    expect(r.get(1)).toEqual({ text: "" });
    expect(r.get(2)).toEqual({ failed: "text recognition stopped on it" });
    expect(r.get(3)).toEqual({ text: "" });

    const started = Date.now();
    r = await supervise(sh("sleep 30"), [1, 2], 5000, 600);
    expect(Date.now() - started).toBeLessThan(5000);
    expect("failed" in r.get(1)! && "failed" in r.get(2)!).toBe(true);

    r = await supervise(() => ({ cmd: "/nonexistent/recogniser", args: [] }), [7], 1000, 1000);
    const p = r.get(7)!;
    expect("failed" in p && p.failed.includes("couldn’t start")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("programs (ported from tesseract.rs)", () => {
  it("programs that fail or are missing say so", async () => {
    expect(find("phaethon-no-such-program")).toBeNull();
    expect((await run("/bin/sh", ["-c", "cat"], Buffer.from("page text"))).toString()).toBe("page text");
    await expect(run("/bin/sh", ["-c", "echo broken image >&2; exit 3"], null)).rejects.toThrow(/^sh: broken image$/);
    await expect(run("/nonexistent/tesseract", [], null)).rejects.toThrow("couldn’t start");
    await expect(run("/bin/sh", ["-c", "sleep 5"], null, 200)).rejects.toThrow("sh took too long");
  });
});
