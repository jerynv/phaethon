import { useSyncExternalStore } from "react";

import { getAppearance, getSaveState, getSystemPrefs, subscribe } from "./appearance";

/** The current appearance; re-renders when it changes. */
export const useAppearance = () => useSyncExternalStore(subscribe, getAppearance);
/** The OS's own light/dark, contrast and motion settings, live. */
export const useSystemPrefs = () => useSyncExternalStore(subscribe, getSystemPrefs);
/** Whether the latest change reached the vault. */
export const useSaveState = () => useSyncExternalStore(subscribe, getSaveState);
