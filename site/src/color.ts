/**
 * Reads an `oklch(L% C H)` token (the app's only colour format) and returns it
 * as OKLab, which is what the shader mixes in. So the art in the hero is drawn
 * from the same `--art-*` tokens as the app's own art (src/web/src/index.css).
 */
export type Lab = [number, number, number];

export function parseOklch(value: string): Lab | null {
  const m = value.trim().match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i);
  if (!m) return null;
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const c = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  return [l, c * Math.cos(h), c * Math.sin(h)];
}

/** The `--art-<palette>-0…4` tokens as OKLab, base first. */
export function paletteLab(palette: string, from: Element = document.documentElement): Lab[] {
  const style = getComputedStyle(from);
  const out: Lab[] = [];
  for (let i = 0; i <= 4; i++) {
    const lab = parseOklch(style.getPropertyValue(`--art-${palette}-${i}`));
    if (lab) out.push(lab);
  }
  return out;
}
