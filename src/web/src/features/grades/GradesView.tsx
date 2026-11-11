import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";

export function GradesView({ space }: { space: SpaceView }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title="Grades" />
      <div className="p-6 text-muted-foreground text-sm">{space.name}</div>
    </div>
  );
}
