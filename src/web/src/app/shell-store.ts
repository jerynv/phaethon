import { create } from "zustand";

/** Shell-only overlays: search and the new-space dialog. */
type ShellState = {
  searchOpen: boolean;
  newSpaceOpen: boolean;
  /** Conversation pending deletion (asks first). */
  confirmDelete: { spaceId: string; id: string; title: string } | null;
  setSearchOpen(open: boolean): void;
  setNewSpaceOpen(open: boolean): void;
  setConfirmDelete(target: ShellState["confirmDelete"]): void;
};

export const useShell = create<ShellState>((set) => ({
  searchOpen: false,
  newSpaceOpen: false,
  confirmDelete: null,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setNewSpaceOpen: (newSpaceOpen) => set({ newSpaceOpen }),
  setConfirmDelete: (confirmDelete) => set({ confirmDelete }),
}));
