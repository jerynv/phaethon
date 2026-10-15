// node --test scripts/unit/
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A "still mounted" ref that an effect only ever clears is false from the start in development:
// React's StrictMode mounts, unmounts and mounts again, so every later result is dropped (Codex's
// sign-in sat on "Waiting for you to sign in" after signing in). The effect must set it again.
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

test("an effect that clears a mounted flag on unmount also sets it on mount", () => {
  const bad: string[] = [];
  for (const file of files("src")) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*(\w+)\.current\s*=\s*false;?\s*\}/g)) bad.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});
