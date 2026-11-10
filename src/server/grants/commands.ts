import { commands } from "../rpc/registry.ts";
import { spaceDir } from "../core/vault.ts";
import { grantsView, restoreGrant, revokeGrant } from "./grants.ts";

commands({
  grants_list: ({ space }: { space: string }) => {
    spaceDir(space);
    return grantsView(space);
  },
  grant_revoke: ({ id }: { id: string }) => revokeGrant(String(id)),
  grant_restore: ({ id }: { id: string }) => {
    restoreGrant(String(id));
    return null;
  },
});
