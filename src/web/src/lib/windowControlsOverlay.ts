/**
 * T3's ui primitives ask how tall a native title-bar overlay is, to keep
 * popups clear of it. Phaethon's windows use the system title bar (or macOS's
 * inset traffic lights, which don't overlap popups), so the answer is 0.
 */
export function useNativeTitlebarHeight(): number {
  return 0;
}
