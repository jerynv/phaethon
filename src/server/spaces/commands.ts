import { commands } from "../rpc/registry.ts";
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

  space_touch: ({ id }: { id: string }) => {
    touchSpace(id);
    return null;
  },
});
