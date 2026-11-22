import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { spaceDir } from "../core/vault.ts";
import { listSpaces } from "../spaces/meta.ts";
import { telemetry } from "../telemetry/client.ts";
import { search } from "./search.ts";

commands({
  conversations_search: async ({ space, query, allSpaces }: { space: string; query: string; allSpaces?: boolean }) => {
    let scope: [string, string][];
    if (allSpaces) {
      scope = [];
      for (const s of listSpaces()) {
        try {
          scope.push([s.id, spaceDir(s.id)]);
        } catch {
          // Gone since it was listed.
        }
      }
    } else scope = [[space, spaceDir(space)]];
    telemetry.capture("usage", "action_completed", { action: "search_used" });
    try {
      return await search(scope, String(query ?? ""));
    } catch (e) {
      throw new Refusal(`The search stopped unexpectedly: ${messageOf(e)}`);
    }
  },
});
