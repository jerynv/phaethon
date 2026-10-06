import { createContext, useContext } from "react";

/**
 * The settings window's one status line. `say` puts a short confirmation in a
 * polite live region ("Text size reset."); `fail` shows an error as an alert.
 */
export type SettingsStatus = { say: (message: string) => void; fail: (message: string) => void };

export const StatusContext = createContext<SettingsStatus>({ say: () => {}, fail: () => {} });

export const useStatus = () => useContext(StatusContext);
