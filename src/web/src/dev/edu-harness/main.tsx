/**
 * Dev-only harness for the education screens: mounts Study, Grades, Plan and
 * Courses against the fake core, with the theme, text scale and space chosen
 * in the hash: `#mock&view=study&theme=dark&scale=1.5&space=school&scenario=empty`.
 * Open at /src/dev/edu-harness/index.html on the dev server. Not part of the app.
 */
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "katex/dist/katex.min.css";
import "./theme.css";

import { useEffect } from "react";
import ReactDOM from "react-dom/client";

import { useNav, type View } from "@/app/nav";
import { CoursesView } from "@/features/courses/CoursesView";
import { GradesView } from "@/features/grades/GradesView";
import { PlanView } from "@/features/plan/PlanView";
import { StudyView } from "@/features/study/StudyView";

import { installMockCore, mockParams } from "../mock-core";

const params = mockParams();
const theme = params.get("theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.fontSize = `${Number(params.get("scale") ?? "1") * 100}%`;
if (params.get("motion") === "reduce") document.documentElement.dataset.reduceMotion = "true";

const VIEWS = ["study", "grades", "plan", "courses"] as const;

function Harness() {
  const nav = useNav();
  useEffect(() => {
    const v = params.get("view") ?? "study";
    nav.go({ kind: (VIEWS as readonly string[]).includes(v) ? v : "study" } as View, params.get("space") ?? "school");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const space = nav.spaceId;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <nav aria-label="Harness" className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5 text-sm">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={nav.view.kind === v}
            className="rounded-md px-2.5 py-1 capitalize aria-pressed:bg-accent aria-pressed:font-medium"
            onClick={() => nav.go({ kind: v } as View)}
          >
            {v}
          </button>
        ))}
        <span className="ms-auto text-muted-foreground">space: {space}</span>
        {nav.file && (
          <span className="ms-3 rounded-md bg-accent px-2 py-0.5" data-harness-file="">
            Opened {nav.file.path}
            <button type="button" className="ms-2 underline" onClick={nav.closeFile}>
              close
            </button>
          </span>
        )}
        {nav.settings && <span className="ms-3 rounded-md bg-accent px-2 py-0.5">Settings: {nav.settings}</span>}
      </nav>
      <main id="main" className="min-h-0 flex-1">
        {nav.view.kind === "study" && <StudyView spaceId={space} />}
        {nav.view.kind === "grades" && <GradesView spaceId={space} />}
        {nav.view.kind === "plan" && <PlanView spaceId={space} />}
        {nav.view.kind === "courses" && <CoursesView spaceId={space} />}
      </main>
    </div>
  );
}

void (async () => {
  if (location.hash.includes("mock")) await installMockCore();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
})();
