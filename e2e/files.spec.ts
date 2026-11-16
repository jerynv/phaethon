import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, startCore, test, type Core } from "./core";

/**
 * The Files view against the real core: the space's files listed as a tree,
 * a file opened in the viewer, rename, move, new folder, delete (to a stand-in
 * trash), search, Settings › Spaces › Files, and a folder kept from
 * Phaethon's agent refused by its own file tools in a scripted turn.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const space = (home: string, ...p: string[]) => path.join(home, "Phaethon", "default", "spaces", "school", ...p);

function seed(home: string) {
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(space(home, rel)), { recursive: true });
    fs.writeFileSync(space(home, rel), text);
  };
  w("readme.md", "# Read me first\n\nThe plan for this term.\n");
  w("notes/week1.md", "# Week 1\n\nSets and functions.\n");
  w("notes/week2.md", "# Week 2\n\nInduction.\n");
  w("essays/draft.txt", "A first draft.\n");
  w("private/diary.md", "secret banana\n");
  w(".phaethon/space.json", JSON.stringify({ name: "School", educationEnabled: false, files: { excluded: ["private"] } }));
}

async function start(page: Page, script?: object) {
  core = await startCore({ setup: seed, script, env: { PHAETHON_TRASH_DIR: "__HOME__/trash" } });
  await core.open(page);
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Files/ }).click();
  const tree = page.getByRole("tree", { name: "Files in School" });
  await expect(tree).toBeVisible();
  return { tree, home: core.home };
}

const item = (tree: ReturnType<Page["getByRole"]>, name: string) => tree.getByRole("treeitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`) });

test("lists the space's files, opens one in the viewer, expands a folder and searches by name", async ({ page }) => {
  const { tree } = await start(page);
  await expect(tree.getByRole("treeitem")).toHaveCount(4);
  await expect(item(tree, "essays")).toBeVisible();
  await expect(item(tree, "notes")).toHaveAttribute("aria-label", /folder, 2 items/);
  // The folder kept from Phaethon's agent carries the lock.
  await expect(item(tree, "private")).toHaveAttribute("aria-label", /kept from Phaethon’s agent/);
  await expect(item(tree, "private").getByTestId("excluded-lock")).toBeVisible();

  await item(tree, "readme.md").click();
  await expect(page.getByText("The plan for this term.")).toBeVisible();

  await item(tree, "notes").click();
  await expect(item(tree, "notes")).toHaveAttribute("aria-expanded", "true");
  await expect(item(tree, "week1.md")).toBeVisible();
  // The keyboard: ↓ to the first file inside, Enter opens it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Sets and functions.")).toBeVisible();

  await page.getByRole("searchbox", { name: "Search files by name" }).fill("week2");
  const results = page.getByRole("tree", { name: "Files matching week2" });
  await expect(results.getByRole("treeitem")).toHaveCount(1);
  await expect(item(results, "week2.md")).toHaveAttribute("aria-label", /in notes/);
  await page.getByRole("searchbox", { name: "Search files by name" }).press("Escape");
  await expect(tree.getByRole("treeitem").first()).toBeVisible();
});

test("renames, moves, makes a folder and deletes after asking", async ({ page }) => {
  const { tree, home } = await start(page);

  // Rename from the right-click menu.
  await item(tree, "readme.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Rename/ }).click();
  const box = page.getByRole("dialog").getByRole("textbox");
  await expect(box).toHaveValue("readme.md");
  await box.fill("start-here.md");
  await box.press("Enter");
  await expect(item(tree, "start-here.md")).toBeVisible();
  expect(fs.existsSync(space(home, "start-here.md"))).toBe(true);
  expect(fs.existsSync(space(home, "readme.md"))).toBe(false);

  // Move it into a folder from its … menu.
  await item(tree, "start-here.md").hover();
  await page.getByRole("button", { name: "start-here.md actions" }).click();
  await page.getByRole("menuitem", { name: /^Move to folder/ }).click();
  await page.getByRole("dialog").getByRole("option", { name: /^notes/ }).click();
  await page.getByRole("button", { name: "Move here" }).click();
  await expect(item(tree, "start-here.md")).toHaveCount(0);
  expect(fs.existsSync(space(home, "notes", "start-here.md"))).toBe(true);

  // A new folder from the page's actions.
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Week 3");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(item(tree, "Week 3")).toBeVisible();
  expect(fs.statSync(space(home, "Week 3")).isDirectory()).toBe(true);

  // Delete with the keyboard asks first; Cancel keeps it, the second time it goes to the trash.
  await item(tree, "essays").click();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Move “essays” to the Trash?");
  await expect(confirm).toContainText("The 1 item in it go too.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(fs.existsSync(space(home, "essays/draft.txt"))).toBe(true);
  await item(tree, "essays").click();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect(item(tree, "essays")).toHaveCount(0);
  expect(fs.existsSync(space(home, "essays"))).toBe(false);
  expect(fs.readFileSync(path.join(home, "trash", "essays", "draft.txt"), "utf8")).toBe("A first draft.\n");
});

test("Settings › Spaces › Files keeps a folder from the agent and shows hidden files", async ({ page }) => {
  core = await startCore({ setup: seed });
  await core.open(page);
  await page.locator("[aria-keyshortcuts]").filter({ hasText: /^Settings/ }).first().click();
  // The section's row carries the number of spaces ("Spaces 2").
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: /^Spaces/ }).click();
  await page.getByRole("button", { name: /^School/ }).click();
  await expect(page.getByRole("list", { name: "Folders kept from Phaethon’s agent" }).getByText("private/")).toBeVisible();
  await page.getByRole("button", { name: "Add folder…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: /notes/ }).click();
  await dialog.getByRole("button", { name: "Keep out “notes”" }).click();
  await expect(page.getByRole("list", { name: "Folders kept from Phaethon’s agent" }).getByText("notes/")).toBeVisible();
  const meta = () => JSON.parse(fs.readFileSync(space(core!.home, ".phaethon/space.json"), "utf8"));
  expect(meta().files.excluded).toEqual(["private", "notes"]);
  expect(meta().name).toBe("School");
  await page.getByRole("switch", { name: "Show hidden files" }).click();
  await expect.poll(() => meta().files.showHidden).toBe(true);
  await page.getByRole("button", { name: "Let Phaethon’s agent read private" }).click();
  await expect.poll(() => meta().files.excluded).toEqual(["notes"]);
});

test("Phaethon's agent is refused a folder the space keeps from it", async ({ page }) => {
  const script = {
    claude: true,
    steps: [{ tools: [{ name: "read_file", input: { path: "private/diary.md" }, id: "r1" }] }, { text: "That folder is closed to me." }],
  };
  await start(page, script);
  await page.getByRole("tab", { name: /^New chat/ }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("What's in my diary?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("That folder is closed to me.")).toBeVisible();
  const second = core!.requests()[1]!;
  const result = JSON.stringify(second.last);
  expect(result).toContain("tool_result");
  expect(result).toContain("is inside \\\"private/\\\", a folder this space's settings keep from Phaethon's agent");
  expect(result).not.toContain("secret banana");
});

/** Drops real File objects on the view, as a drag from Finder does (dragover, then drop). */
async function dropFiles(page: Page, files: { name: string; text: string; type?: string }[]) {
  await page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.text], f.name, { type: f.type ?? "text/plain" }));
    const target = document.querySelector('[role="tree"]')!;
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, files);
}

test("dropping files adds them: at the top level into files/, inside an opened folder into that folder", async ({ page }) => {
  const { tree, home } = await start(page);
  await dropFiles(page, [
    { name: "syllabus.txt", text: "Week 1: sets\n" },
    { name: "hw 1.md", text: "# HW 1\n" },
  ]);
  await expect(page.getByText("Added 2 files to files/")).toBeVisible();
  await expect.poll(() => fs.existsSync(space(home, "files", "syllabus.txt")) && fs.readFileSync(space(home, "files", "hw 1.md"), "utf8")).toBe("# HW 1\n");
  await expect(tree.getByRole("treeitem", { name: /syllabus\.txt/ })).toBeVisible();

  // Into a folder you've gone into.
  await tree.getByRole("treeitem", { name: /^notes/ }).dblclick();
  await expect(page.getByRole("tree", { name: "Files in notes" })).toBeVisible();
  await dropFiles(page, [{ name: "week3.md", text: "# Week 3\n" }]);
  await expect(page.getByText("Added 1 file to notes/")).toBeVisible();
  await expect.poll(() => fs.existsSync(space(home, "notes", "week3.md"))).toBe(true);
  await expect(page.getByRole("tree", { name: "Files in notes" }).getByRole("treeitem", { name: /week3\.md/ })).toBeVisible();
  // A name already there gets a fresh one instead of overwriting.
  await dropFiles(page, [{ name: "week3.md", text: "second\n" }]);
  await expect.poll(() => fs.readdirSync(space(home, "notes")).filter((n) => n.startsWith("week3")).length).toBe(2);
  expect(fs.readFileSync(space(home, "notes", "week3.md"), "utf8")).toBe("# Week 3\n");
});
