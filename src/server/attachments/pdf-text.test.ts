import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { testPdf } from "../lms/text/test-pdfs.ts";
import { expandForProvider, preparePdfTexts } from "./attachments.ts";

/** A model that can't take PDFs gets an attached PDF's text, as the Rust core did for Chat Completions. */
const env = tempHome("phaethon-pdf-text-");
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

describe("attached PDFs for models without PDF input", () => {
  it("are sent as their text", async () => {
    const dir = spaceDir("school");
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, "attachments", "week3.pdf"), testPdf("Week 3: Hash tables and their load factor"));
    const msgs = [{ role: "user" as const, content: [{ type: "phaethon_attachment", path: "attachments/week3.pdf", media_type: "application/pdf", name: "week3.pdf" }, { type: "text", text: "summarise" }] }];
    await preparePdfTexts("school", msgs);
    const [m] = expandForProvider("school", msgs, { images: true, pdf: false });
    expect(m.content[0]).toMatchObject({ type: "document", title: "week3.pdf", source: { type: "text" } });
    expect(JSON.stringify(m.content[0])).toContain("Week 3: Hash tables and their load factor");
    // Named without its extension, it is still read as the PDF it was saved as.
    fs.writeFileSync(path.join(dir, "attachments", "download"), testPdf("Lecture 9: Recurrences"));
    const bare = [{ role: "user" as const, content: [{ type: "phaethon_attachment", path: "attachments/download", media_type: "application/pdf", name: "download" }] }];
    await preparePdfTexts("school", bare);
    expect(JSON.stringify(expandForProvider("school", bare, { images: true, pdf: false })[0].content[0])).toContain("Lecture 9: Recurrences");
    // Anthropic still gets the PDF itself.
    const [a] = expandForProvider("school", msgs, { images: true, pdf: true });
    expect(a.content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
  });
});
