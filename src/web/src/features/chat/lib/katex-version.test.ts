/// <reference types="node" />
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// index.css loads the app's katex stylesheet; rehype-katex draws the markup.
// Two versions draw ≠, overlines, roots and superscripts out of place.
describe("katex", () => {
  it("rehype-katex draws with the same katex whose stylesheet the app loads", () => {
    const require = createRequire(import.meta.url);
    const app = require("katex/package.json").version;
    const fromRehype = createRequire(path.dirname(require.resolve("rehype-katex")) + "/")("katex/package.json").version;
    expect(fromRehype).toBe(app);
  });
});
