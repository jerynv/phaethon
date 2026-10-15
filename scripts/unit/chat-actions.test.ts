// node --test scripts/unit/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CHAT_ACTION_IDS, MAX_ACTIONS, actionLabel, readActions } from "../../src/lib/chat-actions.ts";

test("a block's ids are read in order, unknown ones and repeats dropped, at most three", () => {
  assert.deepEqual(readActions("add-folder\nadd-files\n"), ["add-folder", "add-files"]);
  assert.deepEqual(readActions('["Add-Folder", "add-folder", "rm -rf", "settings-spaces"]'), ["add-folder", "settings-spaces"]);
  assert.deepEqual(readActions("add-files, attach-files show-folder new-space"), ["add-files", "attach-files", "show-folder"]);
  assert.equal(MAX_ACTIONS, 3);
  assert.deepEqual(readActions("open-terminal\nrun:whoami"), [], "nothing the app doesn't know is drawn");
});

test("every id has the app's own words and icon, and the core tells the assistant the same ids", () => {
  const core = readFileSync(new URL("../../src-tauri/src/app_guide.rs", import.meta.url), "utf8");
  for (const id of CHAT_ACTION_IDS) {
    const { label, icon } = actionLabel(id, "Finder");
    assert.ok(label && icon, id);
    assert.ok(core.includes(`("${id}", "`), `${id} in app_guide.rs`);
  }
  assert.equal(actionLabel("show-folder", "File Explorer").label, "Show in File Explorer");
});
