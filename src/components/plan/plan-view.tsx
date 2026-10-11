import type { Space } from "@/lib/spaces";

/** Placeholder until the Plan view lands (replaced at merge). */
export function PlanView({ space }: { space: Space }) {
  return (
    <div className="m-auto flex max-w-(--ph-measure) flex-col items-center gap-2 px-6 text-center">
      <h2 tabIndex={-1} className="text-lg font-semibold text-ink">
        Plan
      </h2>
      <p className="text-base text-ink-secondary">A study plan for {space.name} will show here.</p>
    </div>
  );
}
