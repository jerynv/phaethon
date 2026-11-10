import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { spaceDir } from "../core/vault.ts";
import { listSpaces } from "../spaces/meta.ts";
import { search } from "./search.ts";

commands({
  conversations_search: ({ space, query, allSpaces }: { space: string; query: string; allSpaces?: boolean }) => {
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
    try {
      return search(scope, String(query ?? ""));
    } catch (e) {
      throw new Refusal(`The search stopped unexpectedly: ${messageOf(e)}`);
    }
  },
});
