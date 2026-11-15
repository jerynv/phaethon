import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { createContext, use } from "react";
import type { ThreadRow } from "../store";

/**
 * What every row of the windowed list reaches for, stable for the list's
 * life, so rows stay memoized while the list re-renders on each scroll.
 */
export type ListContextValue = {
  onDelete(space: string, t: ThreadRow): void;
  rename(key: string | null): void;
  /** Whether `key` is still listed (a row leaving by scrolling, not deletion, goes without a fade). */
  listed(key: string): boolean;
  /** True while the list is being replaced wholesale (a filter), when nothing animates. */
  instant(): boolean;
  retryMore(space: string): void;
  /** The one "…" menu every row's trigger opens, with the row's key as its payload. */
  rowMenu: MenuPrimitive.Handle<string>;
};

export const ListContext = createContext<ListContextValue | null>(null);
export const useList = () => use(ListContext)!;
