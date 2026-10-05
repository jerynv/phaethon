import { useCallback, useEffect, useState } from "react";

const KEY = "steward.sidebar.collapsed";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function write(collapsed: boolean) {
  try {
    window.localStorage.setItem(KEY, collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the
    // sidebar still works, it just will not remember.
  }
}

/** Whether the sidebar is open, remembered per device. */
export function useSidebar() {
  const [open, setOpen] = useState(() => !read());
  useEffect(() => write(!open), [open]);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { open, setOpen, toggle };
}
