import { describe, expect, it } from "vitest";
import type { FileEntry } from "../api";
import { flatRows, flatten, type FolderState } from "./tree";

const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, dir: false, size: 1, modified: 0 });
const dir = (path: string, count = 1): FileEntry => ({ ...file(path), dir: true, count });
const loaded = (entries: FileEntry[], total = entries.length): FolderState => ({ entries, total, loading: false, error: null });

describe("flatten", () => {
  it("lists the folder on show, and under each open folder its own entries, a level deeper", () => {
    const rows = flatten({ "": loaded([dir("notes"), dir("files"), file("a.md")]), notes: loaded([file("notes/w1.md")]) }, "", new Set(["notes"]));
    expect(rows.map((r) => [r.kind, r.key, r.level])).toEqual([
      ["entry", "notes", 1],
      ["entry", "notes/w1.md", 2],
      ["entry", "files", 1],
      ["entry", "a.md", 1],
    ]);
    expect(rows[0]).toMatchObject({ expanded: true, setSize: 3, pos: 1 });
  });

  it("shows loading, empty, error and more lines where a folder has nothing yet or more to come", () => {
    const rows = flatten(
      {
        "": loaded([dir("a"), dir("b"), dir("c"), dir("d")], 10),
        b: loaded([]),
        c: { entries: [], total: 0, loading: false, error: "Couldn’t read it" },
      },
      "",
      new Set(["a", "b", "c"]),
    );
    expect(rows.map((r) => r.kind)).toEqual(["entry", "loading", "entry", "empty", "entry", "error", "entry", "more"]);
    expect(rows.at(-1)).toMatchObject({ kind: "more", left: 6, parent: "" });
  });

  it("starts at a folder drilled into, and flat lists are one level", () => {
    expect(flatten({ notes: loaded([file("notes/w1.md")]) }, "notes", new Set()).map((r) => r.key)).toEqual(["notes/w1.md"]);
    expect(flatRows([file("x/a.md"), file("b.md")]).map((r) => [r.level, r.key])).toEqual([
      [1, "x/a.md"],
      [1, "b.md"],
    ]);
  });
});
