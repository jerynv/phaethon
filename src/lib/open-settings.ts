export function openSettings(section?: string) { window.dispatchEvent(new CustomEvent("phaethon:open-settings", { detail: { section } })); }
