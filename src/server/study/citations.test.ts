import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import { check, MAX, type Asked } from "./citations.ts";
import { fixture, put } from "./testing.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

const ask = (p: string, quote: string): Asked => ({ path: p, quote });

describe("citations", () => {
  it("found_missing_and_outside", () => {
    put("courses/C241/files/Notes.pdf", "%PDF");
    put("courses/C241/files/Notes.pdf.md", "# Text of Notes.pdf\n\n5.3 Properties of Functions\n\nA function f is\ninjective if no two inputs give the same output.");
    put("courses/C241/grades.md", "Grade: 91% on everything so far");
    put("secret.md", "A function f is injective if no two inputs give the same output.");
    const vis = fixture("s", [["C241", ["files"]]]);
    const space = spaceDir("s");
    put("notes.md", "My own notes say sets have members.", space);
    const got = check(space, vis, [
      ask("courses/C241/files/Notes.pdf", "A function f is injective if no two inputs give the same output."),
      ask("courses/C241/files/Notes.pdf.md", "injective if no two inputs give the same output"),
      ask("courses/C241/files/Notes.pdf", "A function is surjective if every output is hit."),
      ask("courses/C241/grades.md", "Grade: 91% on everything so far"),
      ask("../../secret.md", "A function f is injective if no two inputs"),
      ask("/etc/hosts", "localhost is the local machine here"),
      ask("notes.md", "My own notes say sets have members."),
      ask("courses/C241/files/Notes.pdf", "f is"),
    ]);
    expect(got[0]).toMatchObject({ found: true, path: "courses/C241/files/Notes.pdf", name: "Notes.pdf", at: "§5.3" });
    expect(got[0]!.passage).toBe("A function f is injective if no two inputs give the same output.");
    expect(got[1]).toMatchObject({ found: true, path: "courses/C241/files/Notes.pdf" });
    expect(got[2]).toMatchObject({ found: false, why: "Those words aren’t in that file." });
    for (const g of got.slice(3, 6)) {
      expect(g.found).toBe(false);
      expect(g.why).toContain("isn’t a file");
      expect(g.passage ?? "").toBe("");
    }
    expect(got[6]!.found).toBe(true);
    expect(got[7]!.why).toContain("too short");
  });

  it("citations_keep_the_original_pdf_page_from_ocr_and_text_copies", () => {
    fs.rmSync(path.join(vaultRoot(), "courses"), { recursive: true, force: true });
    put("courses/C241/files/Notes.pdf", "%PDF");
    put(
      "courses/C241/files/Notes.pdf.md",
      "# Text of Notes.pdf\n\n## Page 1\n\nFirst page.\n\n## Page 2\n\nSecond page.\n\n## Page 3 (recognised from handwriting or a scan; may contain mistakes)\n\nEvery finite tree with n vertices has n minus one edges.\n",
    );
    const vis = fixture("s", [["C241", ["files"]]]);
    const r = check(spaceDir("s"), vis, [ask("courses/C241/files/Notes.pdf.md", "Every finite tree with n vertices has n minus one edges")]);
    expect(r[0]!.found).toBe(true);
    expect(r[0]!.page).toBe(3);
    expect(r[0]!.path).toBe("courses/C241/files/Notes.pdf");
  });

  it("citations past the limit are answered as not checked", () => {
    const vis = fixture("s", [["C241", ["files"]]]);
    const many = Array.from({ length: MAX + 2 }, () => ask("nope.md", "words that are long enough to check"));
    const r = check(spaceDir("s"), vis, many);
    expect(r.length).toBe(MAX + 2);
    expect(r[MAX]!.why).toBe("Not checked: only the first 60 citations in a reply are checked.");
    expect(r[MAX - 1]!.why).toContain("isn’t a file");
  });
});
