import "./overrides.css";

import { startAppearance } from "./appearance";

export {
  effective,
  endPreview,
  flushAppearance,
  getAppearance,
  getSaveState,
  getSystemPrefs,
  previewAppearance,
  resetTokens,
  setAppearance,
  setToken,
  subscribe,
  type SaveState,
  type SystemPrefs,
} from "./appearance";
export * from "./tokens";
export { useAppearance, useSaveState, useSystemPrefs } from "./use-appearance";

/**
 * Applies the user's appearance before the first render: theme, contrast,
 * motion and token overrides, from the cached copy at once and from the
 * vault's settings once loaded. Follows system settings live where the
 * user chose "system".
 */
export function initAppearance(): void {
  startAppearance();
}
