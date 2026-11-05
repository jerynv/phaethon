import canvas from "@/assets/course-sites/canvas-mark.svg";
import iu from "@/assets/course-sites/school.svg";
import moodle from "@/assets/course-sites/moodle-mark.svg";
import type { LmsConnection } from "@/lib/lms";

/** Local source assets; brand marks stay square and never load third-party favicons. */
export function CourseSiteMark({ connection }: { connection: Pick<LmsConnection, "kind" | "address" | "schoolName"> }) {
  const host = (() => { try { return new URL(connection.address).hostname; } catch { return ""; } })();
  const example = host === "example.edu" || host.endsWith(".example.edu") || /example university/i.test(connection.schoolName ?? "");
  const source = example ? iu : connection.kind === "canvas" ? canvas : connection.kind === "moodle" ? moodle : null;
  return <span data-course-site-brand={example ? "iu" : connection.kind} className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md p-1" style={{ background: "oklch(1 0 0)" }}>
    {source ? <img src={source} alt="" className="size-full object-contain" /> : <span aria-hidden="true" className="text-sm font-semibold" style={{ color: "oklch(0.2 0 0)" }}>{connection.kind === "blackboard" ? "Bb" : "D2L"}</span>}
  </span>;
}
