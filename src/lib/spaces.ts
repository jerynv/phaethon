/**
 * Stub space data. In the real app this comes from the active vault's
 * `spaces/` directory (see docs/ARCHITECTURE.md).
 */
export type Space = {
  id: string;
  name: string;
  description: string;
  /**
   * The space's own hue (oklch hue angle, 0 to 360). It becomes `--ph-space-h`
   * wherever the space is shown, so each compartment is recognisable at a
   * glance. Lightness and chroma come from the theme tokens, so any hue stays
   * soft and keeps its contrast.
   */
  hue: number;
};

export const STUB_SPACES: readonly Space[] = [
  { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 },
  { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 55 },
];
