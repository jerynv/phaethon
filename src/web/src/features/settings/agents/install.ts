import { useState } from "react";
import { cleanMessage } from "@/components/errors";
import { toast } from "@/components/toast";
import { cancelCliInstall, CLI_INFO, type CliId, installCli } from "./api";

/** Whether Phaethon can install this CLI itself, with its maker's own installer. */
export const canInstall = (cli: string): cli is CliId => !!CLI_INFO[cli as CliId]?.installer;

/**
 * One install at a time, from onboarding or Settings: what's installing, the
 * last error by CLI, and `onInstalled` to refresh whatever lists the CLIs.
 */
export function useCliInstall(onInstalled: (cli: CliId) => Promise<void> | void) {
  const [installing, setInstalling] = useState<CliId | null>(null);
  const [error, setError] = useState<{ cli: CliId; text: string } | null>(null);
  const install = async (cli: CliId) => {
    setError(null);
    setInstalling(cli);
    try {
      const r = await installCli(cli);
      if (r.status === "installed") {
        toast.success(r.message);
        await onInstalled(cli);
      } else if (r.status !== "cancelled") setError({ cli, text: r.message });
    } catch (e) {
      setError({ cli, text: cleanMessage(e) });
    } finally {
      setInstalling(null);
    }
  };
  return { installing, error, install, cancel: (cli: CliId) => void cancelCliInstall(cli) };
}
