/** Calls `callback` whenever `element` changes size; returns the unsubscribe. One shared observer. */
const callbacks = new Map<Element, Set<() => void>>();
let observer: ResizeObserver | null = null;

export function observeResize(element: Element, callback: () => void): () => void {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) for (const fn of callbacks.get(entry.target) ?? []) fn();
  });
  let set = callbacks.get(element);
  if (!set) {
    set = new Set();
    callbacks.set(element, set);
    observer.observe(element);
  }
  set.add(callback);
  return () => {
    set.delete(callback);
    if (set.size === 0) {
      callbacks.delete(element);
      observer?.unobserve(element);
    }
  };
}
