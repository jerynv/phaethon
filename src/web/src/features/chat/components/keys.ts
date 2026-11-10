export const isMac = () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** The modifier key's name as the keyboard prints it. */
export const modKey = () => (isMac() ? "⌘" : "Ctrl");
