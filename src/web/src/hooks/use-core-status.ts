import { useSyncExternalStore } from "react";
import { coreStatus, onCoreStatus, type CoreStatus } from "@/lib/core";

export function useCoreStatus(): CoreStatus {
  return useSyncExternalStore(onCoreStatus, coreStatus, coreStatus);
}
