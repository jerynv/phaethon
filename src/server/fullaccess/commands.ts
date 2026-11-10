import { commands } from "../rpc/registry.ts";
import { getSpace } from "../spaces/meta.ts";
import { fullAccessList, setFullAccess } from "./fullaccess.ts";

commands({
  full_access_list: () => fullAccessList(),
  full_access_set: ({ id, on }: { id: string; on: boolean }) => {
    getSpace(id);
    setFullAccess(id, !!on);
    return !!on;
  },
});
