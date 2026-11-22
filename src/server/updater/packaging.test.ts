import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const yml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe("packaging", () => {
  it("ships every package the core and the shell import, and keeps renderer-only packages out of dependencies", () => {
    const deps = new Set(Object.keys(pkg.dependencies ?? {}));
    const imported = new Set<string>();
    for (const file of [...sources(path.join(root, "src/server")), ...sources(path.join(root, "src/desktop"))]) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from\s+|(?<![.\w])import\s*\(\s*|(?<![.\w])require(?:\.resolve)?\s*\(\s*)["']([^"'./#][^"']*)["']/g)) {
        const spec = m[1];
        if (spec.startsWith("node:") || spec === "electron" || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][\w.-]*(?:\/|$)/.test(spec)) continue;
        imported.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
    for (const name of imported) {
      expect(deps, `${name} is imported by the core or the shell but missing from dependencies`).toContain(name);
    }
    for (const rendererOnly of ["react", "react-dom", "mermaid", "shiki", "@hugeicons/core-free-icons", "@base-ui/react", "motion"]) {
      expect(deps, `${rendererOnly} is renderer-only and should live in devDependencies so app.asar skips it`).not.toContain(rendererOnly);
    }
    expect(yml).toContain("dist/web/**/*");
    expect(yml).toContain("dist/server/**/*");
    expect(yml).toContain("dist/desktop/**/*");
  });

  it("unpacks native modules and hardens the packaged binary", () => {
    expect(yml).toContain('"**/node_modules/@napi-rs/**"');
    for (const fuse of ["runAsNode: false", "enableNodeOptionsEnvironmentVariable: false", "enableNodeCliInspectArguments: false", "enableEmbeddedAsarIntegrityValidation: true", "onlyLoadAppFromAsar: true", "enableCookieEncryption: true"]) {
      expect(yml).toContain(fuse);
    }
  });
});
