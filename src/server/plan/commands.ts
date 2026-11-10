import { spaceDir } from "../core/vault.ts";
import { commands } from "../rpc/registry.ts";
import { visibleFor } from "../study/visible.ts";
import { asPlanState, examsGet, examsSet, savePlan, stateGet, stateSet, upcoming, type Exam } from "./plan.ts";

/** The study planner's commands (`plan_*`), as the Tauri ones were. */

function examsArg(v: unknown): Exam[] {
  if (!Array.isArray(v)) throw "invalid args `exams` for command `plan_exams_set`: expected a list of exams";
  return v.map((e) => {
    const o = e as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.title !== "string" || typeof o.date !== "string" || (o.course != null && typeof o.course !== "string")) {
      throw "invalid args `exams` for command `plan_exams_set`: each exam needs an id, a title and a date";
    }
    const out: Exam = { id: o.id, title: o.title, date: o.date };
    if (typeof o.course === "string") out.course = o.course;
    return out;
  });
}

commands({
  plan_upcoming: ({ space }: { space: unknown }) => {
    spaceDir(space);
    return upcoming(visibleFor(space as string), Math.floor(Date.now() / 1000));
  },
  plan_exams_get: ({ space }: { space: unknown }) => examsGet(spaceDir(space)),
  plan_exams_set: ({ space, exams }: { space: unknown; exams: unknown }) => {
    const dir = spaceDir(space);
    return examsSet(dir, examsArg(exams));
  },
  plan_save: ({ space, markdown }: { space: unknown; markdown: unknown }) => {
    const dir = spaceDir(space);
    if (typeof markdown !== "string") throw "invalid args `markdown` for command `plan_save`: expected a string";
    return savePlan(dir, markdown);
  },
  plan_state_get: ({ space }: { space: unknown }) => stateGet(spaceDir(space)),
  plan_state_set: ({ space, planState }: { space: unknown; planState: unknown }) => {
    const dir = spaceDir(space);
    let state;
    try {
      state = asPlanState(planState);
    } catch (e) {
      throw `invalid args \`planState\` for command \`plan_state_set\`: ${String(e)}`;
    }
    return stateSet(dir, state);
  },
});
