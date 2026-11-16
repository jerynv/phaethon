import { useCallback, useState } from "react";
import { observeResize } from "@/lib/observe-resize";

/**
 * Whether an element is narrower than `width` px, kept current as it resizes.
 * For layout behaviour CSS can't express (what a click does, which pane is
 * shown); styling alone uses a container query instead. Returns a callback
 * ref for the element and the answer (false until it is measured).
 */
export function useNarrow<T extends HTMLElement>(width: number): [(el: T | null) => void, boolean] {
  const [narrow, setNarrow] = useState(false);
  const ref = useCallback(
    (el: T | null) => {
      if (!el) return;
      const check = () => setNarrow(el.getBoundingClientRect().width < width);
      check();
      return observeResize(el, check);
    },
    [width],
  );
  return [ref, narrow];
}
