import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const yml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe("packaging", () => {
  it("leaves out only packages the core and the shell never import", () => {
    const excluded = [...yml.matchAll(/"!\*\*\/node_modules\/\{([^}]+)\}\/\*\*"/g)].flatMap((m) => m[1].split(","));
    expect(excluded).toContain("mermaid");
    const imported = new Set<string>();
    for (const file of [...sources(path.join(root, "src/server")), ...sources(path.join(root, "src/desktop"))]) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"'./#][^"']*)["']/g)) {
        const spec = m[1];
        if (spec.startsWith("node:")) continue;
        imported.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
    const scopes = excluded.filter((e) => e.startsWith("@") && !e.includes("/"));
    for (const name of imported) {
      expect(excluded, `${name} is imported by the core or the shell but left out of the package`).not.toContain(name);
      for (const scope of scopes) expect(name.startsWith(scope + "/"), `${name} is in the left-out scope ${scope}`).toBe(false);
    }
  });

  it("unpacks native modules and hardens the packaged binary", () => {
    expect(yml).toContain('"**/node_modules/@napi-rs/**"');
    for (const fuse of ["runAsNode: false", "enableNodeOptionsEnvironmentVariable: false", "enableNodeCliInspectArguments: false", "enableEmbeddedAsarIntegrityValidation: true", "onlyLoadAppFromAsar: true", "enableCookieEncryption: true"]) {
      expect(yml).toContain(fuse);
    }
  });
});
