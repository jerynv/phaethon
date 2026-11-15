import { useEffect, useState } from "react";

/** True once `active` has stayed true for `ms`, so quick loads never flash a skeleton. */
export function useDelayed(active: boolean, ms = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && shown;
}
