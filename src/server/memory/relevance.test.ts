import { describe, expect, it } from "vitest";
import type { MemoryItem } from "./items.ts";
import { isSmallTalk, peopleNamed, scoreItems, selectRelevant, timeWindows } from "./relevance.ts";

// Sunday Nov 15 2026, 2 pm local.
const NOW = new Date(2026, 10, 15, 14, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

function item(p: Partial<MemoryItem> & Pick<MemoryItem, "id" | "kind" | "text">): MemoryItem {
  return { space: "work", scope: "space", created: NOW - 3_600_000, updated: NOW, status: "active", keywords: [], people: [], origin: "agent", ...p };
}

const meeting = item({ id: "m1", kind: "event", text: "Team meeting with Dana at the office", when: at(21, 6), keywords: ["standup"], people: ["dana"] });
const sick = item({ id: "m2", kind: "state", text: "Food poisoning; out of work and emailing managers", until: at(17, 9), scope: "vault" });
const tax = item({ id: "m3", kind: "task", text: "File the quarterly tax estimate", when: at(30, 17) });
const vent = item({ id: "m4", kind: "note", text: "Prefers written check-ins over calls with the lab manager", people: ["lee"] });
const all = [meeting, sick, tax, vent];
const people = [
  { id: "dana", names: ["Dana Reyes", "Dana", "boss", "manager"] },
  { id: "lee", names: ["Lee Park", "lab manager"] },
];

describe("small talk", () => {
  it.each(["hi", "hey!", "Hello", "good morning", "thanks", "ok", "lol", "how are you?", "   "])("%s brings nothing", (t) => {
    expect(isSmallTalk(t)).toBe(true);
    expect(scoreItems(all, { text: t, now: NOW, people })).toEqual([]);
  });

  it("a real question is not small talk", () => {
    expect(isSmallTalk("hi, can you help me plan saturday?")).toBe(false);
  });
});

describe("time cues", () => {
  it("Saturday points at the coming Saturday", () => {
    const w = timeWindows("what's my saturday morning look like", NOW);
    expect(w.some((x) => at(21, 6) >= x.from && at(21, 6) <= x.to)).toBe(true);
  });

  it("tomorrow, this weekend, a date", () => {
    expect(timeWindows("tomorrow", NOW)[0]!.from).toBe(at(16, 0));
    // From a Wednesday, the coming weekend; on a Sunday, "this weekend" is the one under way.
    const wk = timeWindows("anything this weekend?", at(18, 10)).find((x) => x.label === "weekend")!;
    expect(at(21, 6) >= wk.from && at(21, 6) <= wk.to).toBe(true);
    const sunday = timeWindows("anything this weekend?", NOW).find((x) => x.label === "weekend")!;
    expect(NOW >= sunday.from && NOW <= sunday.to).toBe(true);
    expect(timeWindows("on Nov 30", NOW).some((x) => at(30, 17) >= x.from && at(30, 17) <= x.to)).toBe(true);
  });
});

describe("relevance", () => {
  it("the 6 am Saturday meeting comes up when the message is about Saturday morning", () => {
    const picked = selectRelevant(all, { text: "what's my Saturday morning look like?", now: NOW, people });
    expect(picked.map((p) => p.item.id)).toContain("m1");
    expect(picked.map((p) => p.item.id)).not.toContain("m3");
  });

  it("not for an unrelated question", () => {
    const picked = selectRelevant(all, { text: "explain the difference between a list and a tuple in python", now: NOW, people });
    expect(picked).toEqual([]);
  });

  it("naming the boss brings the meeting with them", () => {
    const picked = selectRelevant(all, { text: "remind me what's going on with my boss", now: NOW, people });
    expect(picked.map((p) => p.item.id)).toContain("m1");
  });

  it("a current state comes up when the message is about getting in touch or availability", () => {
    expect(selectRelevant(all, { text: "draft an email to my team about tomorrow", now: NOW, people }).map((p) => p.item.id)).toContain("m2");
    expect(selectRelevant(all, { text: "can I make the 3pm review tomorrow?", now: NOW, people }).map((p) => p.item.id)).toContain("m2");
  });

  it("a state stops mattering once it has ended (the sweep closes it; closed items never score)", () => {
    expect(scoreItems([{ ...sick, status: "expired" }], { text: "email my team", now: NOW, people })).toEqual([]);
  });

  it("an event that has passed comes up when the message says how it went", () => {
    const later = at(21, 9);
    const picked = selectRelevant([meeting], { text: "the meeting went well", now: later, people });
    expect(picked.map((p) => p.item.id)).toEqual(["m1"]);
  });

  it("the turn before carries the topic into a short follow-up", () => {
    const picked = selectRelevant(all, { text: "ok, draft it", recent: "I need to tell Dana the standup moves", now: NOW, people });
    expect(picked.map((p) => p.item.id)).toContain("m1");
  });

  it("regressions from realistic phrasings (Friday 8 pm, meeting Saturday 6 am, sick until Saturday evening)", () => {
    const fri = at(20, 20);
    const items = [
      { ...meeting, when: at(21, 6) },
      { ...sick, until: at(21, 18) },
      item({ id: "inv", kind: "task", text: "Send the client invoice for October", when: at(25, 17) }),
    ];
    const ids = (text: string) => selectRelevant(items, { text, now: fri, people }).map((p) => p.item.id);
    // A coding question isn't about availability (single letters once counted as cue words).
    expect(ids("how do I center a div")).toEqual([]);
    expect(ids("plan my evening")).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect(ids("I'm feeling better")).toContain("m2");
    expect(ids("remind me what I owe the client")).toEqual(["inv"]);
    expect(ids("write an email to my professor about the homework")).toContain("m2");
  });

  it("people match whole words only", () => {
    expect(peopleNamed("Danger zone", people)).toEqual([]);
    expect(peopleNamed("tell my boss", people)).toEqual(["dana"]);
    expect(peopleNamed("the lab manager wants a call", people)).toContain("lee");
  });
});
