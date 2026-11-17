/**
 * Scroll reveal: blocks marked data-reveal that start below the screen rise
 * in as they reach it, once. Anything already on screen when the page loads
 * is left alone (no flash on arrival), the page is complete without script,
 * and with reduced motion nothing is hidden at all. --i staggers siblings.
 */
export function reveal(): () => void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return () => {};
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        (e.target as HTMLElement).dataset.reveal = "in";
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
    if (el.getBoundingClientRect().top < window.innerHeight) continue;
    el.dataset.reveal = "pending";
    io.observe(el);
  }
  return () => io.disconnect();
}
