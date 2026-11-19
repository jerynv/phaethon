import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanNotes, notesText } from "../../../../server/updater/updates";
import { parseNotes } from "./notes";

/**
 * The path real release notes take: GitHub's HTML for the release (what
 * electron-updater hands the core; these fixtures are the 0.3.0 and 0.3.1
 * releases' body_html), the core's notesText and cleanNotes, then the
 * dialog's parseNotes.
 */
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf8");
const shown = (html: string) => parseNotes(cleanNotes(notesText(html)));

describe("real release notes in the update dialog", () => {
  it("0.3.1: the four changes, without the download preamble", () => {
    const blocks = shown(fixture("release-0.3.1.html"));
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list.kind).toBe("list");
    if (list.kind !== "list") return;
    expect(list.items).toHaveLength(4);
    expect(list.items[0]!.lead).toBe("Figures in replies are drawn again.");
    expect(list.items.map((i) => `${i.lead ?? ""} ${i.text}`).join(" ")).not.toMatch(/assets below|installer for your operating system/);
  });

  it("0.3.0: the preamble and the seven changes; no file names, headings or Gatekeeper steps", () => {
    const blocks = shown(fixture("release-0.3.0.html"));
    const text = JSON.stringify(blocks);
    expect(blocks[0]).toMatchObject({ kind: "text", text: expect.stringContaining("Pre-alpha desktop build") });
    const lists = blocks.filter((b) => b.kind === "list");
    expect(lists).toHaveLength(1);
    if (lists[0]!.kind !== "list") return;
    expect(lists[0]!.items).toHaveLength(7);
    expect(lists[0]!.items.map((i) => i.lead)).toEqual([
      "Memory that fades when it stops mattering.",
      "People.",
      "Mail.",
      "Automations.",
      "Files.",
      "In the menu bar.",
      // No short first sentence: the whole line is the body.
      null,
    ]);
    expect(text).not.toMatch(/\.dmg|\.exe|AppImage|xattr|Open Anyway|SmartScreen|New in 0\.3\.0|can’t update itself|can't update itself/);
  });
});
