/**
 * Stub space data. In the real app this comes from the active vault's
 * `spaces/` directory (see docs/ARCHITECTURE.md).
 */
export type Space = {
  id: string;
  name: string;
  description: string;
};

export const STUB_SPACES: readonly Space[] = [
  { id: "school", name: "school", description: "Courses, deadlines, study notes" },
  { id: "work", name: "work", description: "Projects, meetings, follow-ups" },
];
