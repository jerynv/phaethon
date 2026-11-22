import fs from "node:fs";
import path from "node:path";
import { lstatOrNull } from "../core/fsx.ts";
import { isSpaceBusy } from "../core/runs.ts";
import { isTrashedSpace, spaceDir, spacesRoot, spaceTrashRoot } from "../core/vault.ts";
import { host } from "../host.ts";
import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { telemetry } from "../telemetry/client.ts";
import { createSpace, listSpaces, touchSpace, updateSpace } from "./meta.ts";

type Opt<T> = T | null | undefined;

commands({
  spaces_list: () => listSpaces(),

  space_create: (a: { name: string; description?: Opt<string>; hue?: Opt<number>; educationEnabled?: Opt<boolean> }) => {
    const space = createSpace(String(a.name ?? ""), a.description, a.hue, a.educationEnabled ?? false);
    telemetry.capture("usage", "action_completed", { action: "space_created" });
    return space;
  },

  space_update: (a: { id: string; name?: Opt<string>; description?: Opt<string>; hue?: Opt<number>; educationEnabled?: Opt<boolean> }) =>
    updateSpace(a.id, { name: a.name, description: a.description, hue: a.hue, educationEnabled: a.educationEnabled }),

  space_delete: ({ id }: { id: string }) => {
    const dir = spaceDir(id);
    if (listSpaces().length <= 1) throw new Refusal("Keep at least one space.");
    if (isSpaceBusy(id)) throw new Refusal("Wait for the replies in this space to finish before deleting it.");
    const trash = spaceTrashRoot();
    const destination = path.join(trash, id);
    try {
      if (!lstatOrNull(spacesRoot())?.isDirectory()) throw new Error("The spaces folder is not a regular folder.");
      const existing = lstatOrNull(trash);
      if (!existing) fs.mkdirSync(trash);
      else if (!existing.isDirectory()) throw new Error("The space trash is not a regular folder.");
      if (lstatOrNull(destination)) throw new Error("The space trash already has a folder with that ID.");
      // A single rename retires the active folder and reserves its ID together.
      fs.renameSync(dir, destination);
    } catch (e) {
      throw new Refusal(`The space couldn’t be moved to the trash: ${messageOf(e)}`);
    }
    return null;
  },

  space_reveal_deleted: async ({ id }: { id: string }) => {
    if (!isTrashedSpace(id)) throw new Refusal("That space is no longer in the space trash.");
    if (!lstatOrNull(path.join(spaceTrashRoot(), id))?.isDirectory()) throw new Refusal("That deleted space is not a regular folder.");
    return host().call({ op: "revealPath", path: path.join(spaceTrashRoot(), id) });
  },

  space_touch: ({ id }: { id: string }) => {
    touchSpace(id);
    return null;
  },
});
