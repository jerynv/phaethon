import { onStart, onStop } from "../lifecycle.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import type { Channel } from "../rpc/channel.ts";
import { cancelLaunchCheck, install, runCheck, scheduleLaunchCheck, view, type InstallEvent } from "./updates.ts";

commands({
  update_state: () => view(),
  update_check: async () => {
    await runCheck("check");
    return view();
  },
  update_install: async (args: { onEvent: Channel<InstallEvent> }) => {
    try {
      await install(args.onEvent);
    } catch (e) {
      throw new Refusal(e instanceof Error ? e.message : String(e));
    }
    return null;
  },
});

onStart("updater: quiet check after launch", () => scheduleLaunchCheck());
onStop("updater: cancel the launch check", () => cancelLaunchCheck());
