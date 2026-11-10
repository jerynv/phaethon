import { describe, expect, test } from "vitest";

import { applyImportEvent, endText, finishRun, newRun, SIGNED_OUT_DURING_IMPORT, stepText, type Run } from "./import-run";
import { coursesWithout, hiddenCourses, reachOf } from "./reach";
import { courseFolder, courseMatches, folderKey, GENERAL, reconcile, resolveChoice, sameFolder } from "./selection";
import { checkAddress, connectionName, formatBytes, hostOf, isCancelled, isSignedOut, typeLabel } from "./sites";
import { untilTerminal } from "./stream";
import type { CourseInfo, LmsImportEvent } from "./types";

describe("addresses", () => {
  const ex = "canvas.yourschool.edu";
  test("an https origin, or what is wrong in plain words", () => {
    expect(checkAddress("  iu.instructure.com/courses/1 ", ex)).toEqual({ ok: true, address: "https://iu.instructure.com" });
    expect(checkAddress("https://canvas.iu.edu", ex)).toEqual({ ok: true, address: "https://canvas.iu.edu" });
    expect(checkAddress("", ex)).toEqual({ ok: false, problem: `Type your course site’s address, for example ${ex}.` });
    expect(checkAddress("canvas iu.edu", ex)).toMatchObject({ ok: false, problem: expect.stringMatching(/no spaces/) });
    expect(checkAddress("http://canvas.iu.edu", ex)).toMatchObject({ ok: false, problem: expect.stringMatching(/secure addresses/) });
    expect(checkAddress("https://me:pw@canvas.iu.edu", ex)).toMatchObject({ ok: false, problem: expect.stringMatching(/name and password/) });
    expect(checkAddress("localhost", ex)).toMatchObject({ ok: false, problem: expect.stringMatching(/missing its ending/) });
    expect(checkAddress("canvas.iu.edu.", ex)).toMatchObject({ ok: false, problem: expect.stringMatching(/missing its ending/) });
  });

  test("names, errors and sizes", () => {
    expect(hostOf("iu.instructure.com")).toBe("iu.instructure.com");
    expect(connectionName({ address: "https://iu.instructure.com" })).toBe("iu.instructure.com");
    expect(connectionName({ address: "https://iu.instructure.com", schoolName: "IU" })).toBe("IU");
    expect(isSignedOut("signedOut")).toBe(true);
    expect(isSignedOut("You’ve been signed out of Canvas")).toBe(true);
    expect(isCancelled(" Cancelled ")).toBe(true);
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(typeLabel("files/syllabus.pdf")).toBe("PDF");
    expect(typeLabel("x.weird")).toBe("WEIRD");
  });
});

describe("course selection", () => {
  const calc: CourseInfo = { key: "c1/102", connection: "c1", courseId: "102", name: "Calculus II", folder: "courses/Calculus II" };

  test("folders with and without the courses/ prefix are the same course", () => {
    expect(folderKey("courses/Calculus II")).toBe("Calculus II");
    expect(courseFolder("Calculus II")).toBe("courses/Calculus II");
    expect(sameFolder("Calculus II", "courses/calculus ii")).toBe(true);
    // Plan's folder (no prefix) selects the imported course.
    expect(resolveChoice([calc], { folder: "Calculus II", name: "Calculus II" })).toEqual({ key: "c1/102", folder: "courses/Calculus II", name: "Calculus II" });
    // Before access loads: the folder-only selection still has the prefixed folder, so Study finds the course.
    expect(resolveChoice([], { folder: "Calculus II", name: "Calculus II" })).toEqual({ key: "folder:Calculus II", folder: "courses/Calculus II", name: "Calculus II" });
    expect(resolveChoice([], { connection: "c1", courseId: "102", folder: "courses/Calculus II", name: "x" })!.key).toBe("c1/102");
  });

  test("reconciling keeps imported, folder-only and general choices, and drops courses no longer seen", () => {
    expect(reconcile([calc], { key: "folder:Calculus II", folder: "courses/Calculus II", name: "Calc" })).toEqual({ key: "c1/102", folder: "courses/Calculus II", name: "Calculus II" });
    expect(reconcile([], { key: "folder:Old", folder: "courses/Old", name: "Old" })).toEqual({ key: "folder:Old", folder: "courses/Old", name: "Old" });
    expect(reconcile([], { key: GENERAL, folder: GENERAL, name: "General" })?.key).toBe(GENERAL);
    expect(reconcile([], { key: "c1/102", folder: "courses/Calculus II", name: "Calculus II" })).toBeNull();
  });

  test("matching saved course names and folders", () => {
    expect(courseMatches("Calculus II", "courses/Calculus II", "Calculus II")).toBe(true);
    expect(courseMatches("courses/calculus ii", "Calculus II", "x")).toBe(true);
    expect(courseMatches(undefined, GENERAL, "General")).toBe(true);
    expect(courseMatches("Calc", GENERAL, "General")).toBe(false);
    expect(courseMatches(undefined, "courses/Calculus II", "Calculus II")).toBe(false);
  });
});

describe("course reach", () => {
  const view = {
    spaces: ["school", "work"],
    courses: [
      { key: "c1/1", connection: "c1", courseId: "1", name: "A", folder: "courses/A" },
      { key: "c1/2", connection: "c1", courseId: "2", name: "B", folder: "courses/B" },
    ],
    access: { school: { "c1/1": ["files" as const], "c1/2": ["grades" as const, "files" as const], gone: ["files" as const] }, work: {} },
    problems: [],
  };
  test("none, part, or nothing to say", () => {
    expect(hiddenCourses(reachOf(view, "work"))).toBe("none");
    expect(hiddenCourses(reachOf(view, "school"), "assignments")).toBe("part");
    expect(hiddenCourses(reachOf(view, "school"), "grades")).toBeNull();
    expect(hiddenCourses(reachOf({ ...view, courses: [] }, "work"))).toBeNull();
    expect(coursesWithout(reachOf(view, "school"), "grades")).toBe(1);
  });
});

describe("import run", () => {
  const start = () => newRun(1, "school", ["school"], "c1", "IU", [
    { id: "101", name: "Discrete" },
    { id: "102", name: "Calculus II" },
  ]);
  const apply = (r: Run, ...events: LmsImportEvent[]) => events.reduce((x, e) => applyImportEvent(x, e).run, r);
  const imported = { type: "course" as const, folder: "courses/Discrete", files: 12, readings: 1, links: 5, skipped: [] as string[] };

  test("progress, then each course, then done", () => {
    let r = apply(start(), { type: "progress", course: "101", step: "files", done: 2, total: 4 });
    expect(stepText(r.courses[0]!)).toBe("Downloading files: 2 of 4");
    r = apply(r, { ...imported, course: "101" }, { type: "progress", course: "102", step: "reading", done: 0, total: 1 });
    expect(r.courses[0]!.result?.files).toBe(12);
    r = apply(r, { type: "error", message: "Calculus II: the site said you don’t have access" });
    expect(r.courses[1]!.failed).toBe("The site said you don’t have access");
    r = apply(r, { type: "done" });
    expect(r.status).toBe("done");
    expect(endText(r)).toBe("1 of 2 courses imported.");
  });

  test("a course event arriving late, after the command returned, still counts: only done ends the run", () => {
    // The command resolved; the store doesn't finish on that. The big course event lands, then done.
    let r = apply(start(), { type: "progress", course: "101", step: "writing", done: 0, total: 1 });
    r = apply(r, { ...imported, course: "101" }, { ...imported, course: "102", folder: "courses/Calculus II" }, { type: "done" });
    expect(r.courses.map((c) => c.failed)).toEqual([undefined, undefined]);
    expect(endText(r)).toBe("2 courses imported.");
    // Anything after the end is ignored.
    expect(apply(r, { type: "error", message: "late" })).toBe(r);
  });

  test("signed out partway stops the run; cancelled marks the rest stopped; notes without a course", () => {
    let r = apply(start(), { type: "progress", course: "101", step: "files", done: 1, total: 4 }, { type: "error", message: "signedOut" });
    expect(r.status).toBe("failed");
    expect(r.error).toBe(SIGNED_OUT_DURING_IMPORT);
    expect(r.courses[1]!.failed).toBe("You were signed out before this one.");
    r = apply(start(), { type: "error", message: "Some courses aren’t on the site any more." });
    expect(r.notes).toEqual(["Some courses aren’t on the site any more."]);
    r = apply(r, { ...imported, course: "101" }, { type: "cancelled" });
    expect(r.status).toBe("cancelled");
    expect(r.courses[1]!.failed).toBe("Stopped");
    expect(endText(r)).toBe("Import stopped · 1 course saved.");
    expect(finishRun(r, "done")).toBe(r);
  });
});

describe("waiting for a stream's end", () => {
  const fakeTimers = () => {
    const pending: (() => void)[] = [];
    return { pending, timers: { set: (f: () => void) => pending.push(f), clear: () => void pending.splice(0) } };
  };

  test("a terminal event after the command resolved still ends the stream as terminal", async () => {
    const { pending, timers } = fakeTimers();
    const seen: string[] = [];
    let send!: (e: string) => void;
    const done = untilTerminal<string>((on) => ((send = on), Promise.resolve()), (e) => seen.push(e), (e) => e === "done", 15_000, timers);
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    send("course");
    send("done");
    expect(await done).toEqual({ kind: "terminal" });
    expect(seen).toEqual(["course", "done"]);
  });

  test("no terminal event: ends after the grace period; a rejection ends it with the error", async () => {
    const { pending, timers } = fakeTimers();
    const p = untilTerminal<string>(() => Promise.resolve(), () => {}, () => false, 15_000, timers);
    await Promise.resolve();
    await Promise.resolve();
    pending[0]!();
    expect(await p).toEqual({ kind: "timedOut" });
    expect(await untilTerminal<string>(() => Promise.reject("cancelled"), () => {}, () => false)).toEqual({ kind: "rejected", error: "cancelled" });
  });
});
