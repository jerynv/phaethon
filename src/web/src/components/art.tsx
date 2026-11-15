import { useId, useMemo, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Abstract imagery for empty spaces, hero cards and onboarding
 * (docs/UI-REBUILD.md › Art). Soft grainy mesh gradients and a faint dot
 * matrix, generated from a seed so the same place always gets the same
 * picture. Calm by design: no faces, no glyph soup, nothing that reads as
 * "AI art". All colour comes from the `--art-*` tokens in index.css.
 *
 *   <ArtCanvas palette="dawn" seed="welcome" />      a mesh that fills its box
 *   <ArtFrame palette="meadow">{card}</ArtFrame>     a card set into an art panel
 *   <ArtTile palette="sky" seed={id} />              a small rounded thumbnail
 *   <DotMatrix />                                    the faded dots atop a page
 */

export const ART_PALETTES = ["sky", "dawn", "meadow", "lilac", "ember"] as const;
export type ArtPalette = (typeof ART_PALETTES)[number];

/** FNV-1a: a stable 32-bit hash of the seed. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for placing blobs. */
export function seeded(seed: string | number): () => number {
  let a = typeof seed === "number" ? seed >>> 0 : hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A palette picked from a seed, for lists of things that each want their own art. */
export function paletteFor(seed: string): ArtPalette {
  return ART_PALETTES[hash(seed) % ART_PALETTES.length]!;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The layered radial gradients of one mesh. Exported for tests. */
export function meshLayers(palette: ArtPalette, seed: string): string {
  const rand = seeded(`${palette}:${seed}`);
  const layers: string[] = [];
  // Two passes over the four colours: big soft fields first, brighter cores after.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= 4; i++) {
      const x = round(rand() * 100);
      const y = round(rand() * 100);
      const w = round((pass === 0 ? 55 : 28) + rand() * 30);
      const h = round((pass === 0 ? 50 : 24) + rand() * 30);
      const stop = pass === 0 ? 72 : 64;
      layers.push(`radial-gradient(${w}% ${h}% at ${x}% ${y}%, var(--art-${palette}-${i}) 0%, transparent ${stop}%)`);
    }
  }
  return layers.reverse().join(", ");
}

/** Monochrome film grain from SVG turbulence, laid over art with soft light. */
export function Grain({ className, strength = "default" }: { className?: string; strength?: "subtle" | "default" | "strong" }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg aria-hidden className={cn("pointer-events-none absolute inset-0 size-full mix-blend-soft-light", strength === "subtle" ? "opacity-40" : strength === "strong" ? "opacity-90" : "opacity-70", className)}>
      <filter id={`grain-${id}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#grain-${id})`} />
    </svg>
  );
}

type ArtCanvasProps = Omit<ComponentProps<"div">, "children"> & {
  palette?: ArtPalette;
  /** Same seed, same picture. Defaults to the palette name. */
  seed?: string;
  /** Film grain over the mesh (default on). */
  grain?: boolean | "subtle" | "strong";
  /** The woven halftone grid of the references' pricing art. */
  weave?: boolean;
  /** A slow drift of the mesh (off with reduced motion). */
  animate?: boolean;
  children?: ReactNode;
};

/** A mesh gradient that fills its box. Give it a size or put it in a sized, `relative` parent with `absolute inset-0`. */
export function ArtCanvas({ palette = "sky", seed, grain = true, weave = false, animate = false, className, children, style, ...props }: ArtCanvasProps) {
  const layers = useMemo(() => meshLayers(palette, seed ?? palette), [palette, seed]);
  const mesh: CSSProperties = { backgroundImage: layers, backgroundColor: `var(--art-${palette}-0)` };
  return (
    <div data-slot="art" data-palette={palette} className={cn("relative isolate overflow-hidden", className)} style={style} {...props}>
      <div aria-hidden className={cn("absolute -inset-1/8", animate && "motion-safe:animate-art-drift")} style={mesh} />
      {weave ? <div aria-hidden className="art-weave pointer-events-none absolute inset-0" /> : null}
      {grain ? <Grain strength={grain === true ? "default" : grain} /> : null}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-(--art-veil)" />
      {children !== undefined ? <div className="relative z-10 size-full">{children}</div> : null}
    </div>
  );
}

/** A small rounded art thumbnail (action cards, list leaders, onboarding steps). */
export function ArtTile({ className, ...props }: ArtCanvasProps) {
  return <ArtCanvas className={cn("size-16 shrink-0 rounded-xl", className)} grain="subtle" {...props} />;
}

/**
 * A card set into an art panel, after the references' "Thought 12s" frames:
 * the art shows along the top and left edges and the card runs off the
 * bottom-right corner. The panel clips, so the card's own radius only shows
 * at its top-left.
 */
export function ArtFrame({ palette = "sky", seed, className, cardClassName, children, ...props }: Omit<ArtCanvasProps, "children"> & { cardClassName?: string; children: ReactNode }) {
  return (
    <ArtCanvas palette={palette} seed={seed} className={cn("rounded-panel border", className)} {...props}>
      <div className={cn("absolute inset-0 top-10 left-10 overflow-hidden rounded-tl-card bg-card shadow-card", cardClassName)}>{children}</div>
    </ArtCanvas>
  );
}

/**
 * The faint dot matrix that fades out at the top of a page. A seeded field of
 * 2 px squares on a 7 px grid in four opacities, drawn as four paths so it
 * costs a handful of DOM nodes; it takes `--dot-matrix` for colour, so it
 * follows the theme.
 */
export function DotMatrix({ seed = "phaethon", className, density = 0.38 }: { seed?: string; className?: string; density?: number }) {
  const paths = useMemo(() => {
    const rand = seeded(seed);
    const cols = 220;
    const rows = 22;
    const buckets = ["", "", "", ""];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        // Thinner towards the bottom, so the fade starts inside the pattern itself.
        if (rand() > density * (1 - (y / rows) * 0.6)) continue;
        const b = Math.floor(rand() * 4);
        buckets[b] += `M${x * 7} ${y * 7}h2v2h-2z`;
      }
    }
    return buckets;
  }, [seed, density]);
  return (
    <svg
      aria-hidden
      data-slot="dot-matrix"
      viewBox="0 0 1540 154"
      preserveAspectRatio="xMidYMin slice"
      className={cn("mask-fade-top pointer-events-none absolute inset-x-0 top-0 h-24 w-full text-dot-matrix", className)}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} fill="currentColor" opacity={0.35 + i * 0.22} />
      ))}
    </svg>
  );
}
