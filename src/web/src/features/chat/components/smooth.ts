import { useEffect, useRef, useState } from "react";

/**
 * Streaming text revealed at a steady pace instead of in network-sized
 * bursts. The pace grows with the backlog, so the display never falls more
 * than a moment behind, and updates at most ~30 times a second so the
 * Markdown (and its math) isn't re-rendered every frame. Not streaming: the
 * whole text, at once.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text.length);
  const target = useRef(text.length);
  target.current = text.length;

  useEffect(() => {
    if (!streaming) {
      setShown(target.current);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now: number) => {
      const dt = now - last;
      if (dt >= 33) {
        last = now;
        setShown((n) => {
          const goal = target.current;
          if (n >= goal) return goal;
          const backlog = goal - n;
          const perSecond = Math.max(60, backlog * 5);
          carry += (perSecond * dt) / 1000;
          const step = Math.floor(carry);
          carry -= step;
          return Math.min(goal, n + Math.max(1, step));
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [streaming]);

  if (!streaming) return text;
  return text.slice(0, Math.min(shown, text.length));
}
