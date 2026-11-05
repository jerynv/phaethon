import canvas from "@/assets/course-sites/canvas.svg";
import iu from "@/assets/course-sites/iu.svg";
import moodle from "@/assets/course-sites/moodle.svg";
import { Icon } from "@/icons";
import type { LmsConnection } from "@/lib/lms";

/** Official source assets and their origins live together in assets/course-sites. */
export function CourseSiteMark({ connection }: { connection: LmsConnection }) {
  const host = (() => { try { return new URL(connection.address).hostname; } catch { return ""; } })();
  const indiana = host === "iu.edu" || host.endsWith(".iu.edu") || /indiana university/i.test(connection.schoolName ?? "");
  const source = indiana ? iu : connection.kind === "canvas" ? canvas : connection.kind === "moodle" ? moodle : null;
  return (
    <span data-course-site-brand={indiana ? "iu" : connection.kind} className="flex h-9 w-12 shrink-0 items-center justify-center rounded-md px-1.5" style={{ background: "oklch(1 0 0)" }}>
      {source ? <img src={source} alt="" className={indiana ? "h-7 w-auto" : "max-h-7 w-full object-contain"} /> : <Icon name="book" className="text-ink-tertiary" />}
    </span>
  );
}
