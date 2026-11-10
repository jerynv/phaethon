import { describe, expect, it } from "vitest";
import { cardId, cardIds, clozeAnswers, emptyDeck, kindOf, parse, validate, write } from "./deck.ts";
import type { Deck, Note } from "./types.ts";

const REAL = `---
title: Test 1 review
course: CSCI-C 241 Fall 2026 (All Sections)
sources:
  - courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/Test 1 Review - C241 Fa26.pdf
---

Q: When is p → q false?
A: Only when p is true and q is false.
From: courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/Test 1 Review - C241 Fa26.pdf

Q: “A is a necessary condition for B” in propositional logic
A: B → A
(the condition comes after the arrow)

Q: The {{power set}} of a set with n members has {{2^n}} members.

Q: What does |X ∩ Y| mean?
A: The number of members X and Y have in common.
`;

const deckOf = (notes: Note[], extra: Partial<Deck> = {}): Deck => ({ ...emptyDeck(), title: "t", notes, ...extra });
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
};

describe("deck", () => {
  it("a real-looking deck round-trips exactly", () => {
    const d = parse(REAL, "x");
    expect(d.title).toBe("Test 1 review");
    expect(d.course).toBe("CSCI-C 241 Fall 2026 (All Sections)");
    expect(d.sources.length).toBe(1);
    expect(d.notes.length).toBe(4);
    expect(d.notes[0]!.source).toBe("courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/Test 1 Review - C241 Fa26.pdf");
    expect(d.notes[1]!.back).toBe("B → A\n(the condition comes after the arrow)");
    expect(kindOf(d.notes[2]!)).toBe("cloze");
    expect(clozeAnswers(d.notes[2]!.front)).toEqual(["power set", "2^n"]);
    expect(d.notes[2]!.back).toBe("");
    expect(write(d)).toBe(REAL);
    expect(parse(write(d), "x")).toEqual(d);
  });

  it("hand edits are tolerated", () => {
    const text = "﻿# My notes\r\nsome intro\r\n\r\nq: one\r\na: uno\r\n\r\n   Q:two\r\n  A: dos\r\n\r\nmore dos\r\n\r\nQ: three has no answer\r\n";
    const d = parse(text, "Spanish");
    expect(d.title).toBe("Spanish");
    expect(d.preamble).toBe("# My notes\nsome intro");
    expect(d.notes.length).toBe(3);
    expect([d.notes[0]!.front, d.notes[0]!.back]).toEqual(["one", "uno"]);
    expect([d.notes[1]!.front, d.notes[1]!.back]).toEqual(["two", "dos\n\nmore dos"]);
    expect(d.notes[2]!.back).toBe("");
    expect(err(() => validate(d))).toContain("Card 3 has no answer");
    const again = parse(write(d), "Spanish");
    expect(again.notes).toEqual(d.notes);
    expect(again.preamble).toBe(d.preamble);
  });

  it("front matter variants and unknown keys", () => {
    const text = '---\ntitle: "Graph theory: basics"\nsources: [a.md, "b, c.pdf"]\ntags: graphs\n---\nQ: x\nA: y\n';
    const d = parse(text, "f");
    expect(d.title).toBe("Graph theory: basics");
    expect(d.sources).toEqual(["a.md", "b, c.pdf"]);
    expect(d.extra).toEqual(["tags: graphs"]);
    const w = write(d);
    expect(w).toContain('title: "Graph theory: basics"\n');
    expect(w).toContain("tags: graphs\n");
    expect(parse(w, "f").title).toBe("Graph theory: basics");
    const u = parse("---\ntitle: x\nQ: a\nA: b\n", "f");
    expect(u.title).toBe("f");
    expect(u.notes.length).toBe(1);
  });

  it("a title with both a colon and a double quote round-trips (fixed)", () => {
    const d = deckOf([{ front: "a", back: "b" }], { title: '"Hi": x' });
    expect(parse(write(d), "f").title).toBe('"Hi": x');
  });

  it("marker lines inside text are escaped", () => {
    const d = deckOf([{ front: "Line one\nQ: not a new card", back: "A: still the answer\nFrom: not a source", source: "x.md" }]);
    const w = write(d);
    expect(w).toContain("\\Q: not a new card");
    expect(w).toContain("\\From: not a source");
    expect(parse(w, "t")).toEqual(d);
  });

  it("a card's passage is kept after its source", () => {
    const n: Note = {
      front: "What is an injective function?",
      back: "No two inputs share an output.",
      source: "courses/C/notes.pdf",
      quote: "A function f is  injective if\nno two inputs give the same output.",
    };
    const d = deckOf([n, { front: "{{x}} y", back: "", source: "s.md", quote: "a quoted bit of text" }]);
    const w = write(d);
    expect(w).toContain('From: courses/C/notes.pdf\nQuote: "A function f is injective if no two inputs give the same output."\n');
    const back = parse(w, "t");
    expect(back.notes[0]!.quote).toBe("A function f is injective if no two inputs give the same output.");
    expect([back.notes[1]!.source, back.notes[1]!.quote, back.notes[1]!.front]).toEqual(["s.md", "a quoted bit of text", "{{x}} y"]);
    const q = parse("Q: a\nA: b\nQuote: c\n", "t");
    expect([q.notes[0]!.back, q.notes[0]!.quote]).toEqual(["b\nQuote: c", undefined]);
  });

  it("a passage read from a page's picture says so on its source line", () => {
    const src = "courses/C/files/Notes/notes c241 Fa26 - 20260917.pdf";
    const n: Note = { front: "What is a reflexive relation?", back: "(a,a) ∈ R for every a.", source: src, quote: "R is reflexive if (a,a) e R for all a", picture: 3 };
    const w = write(deckOf([n]));
    expect(w).toContain(`From: ${src} (p. 3, read from a picture of the page)\nQuote: "R is reflexive if (a,a) e R for all a"\n`);
    expect(parse(w, "t").notes[0]).toEqual(n);
    const old = parse(`Q: a\nA: b\nFrom: ${src}\nQuote: "c d"\n`, "t");
    expect([old.notes[0]!.source, old.notes[0]!.quote, old.notes[0]!.picture]).toEqual([src, "c d", undefined]);
    const bare = parse(`Q: a\nA: b\nFrom: ${src} (p. 3, read from a picture of the page)\n`, "t");
    expect([bare.notes[0]!.source, bare.notes[0]!.picture]).toEqual([`${src} (p. 3, read from a picture of the page)`, undefined]);
    const odd = parse('Q: a\nA: b\nFrom: x.pdf (p. three, read from a picture of the page)\nQuote: "c"\n', "t");
    expect(odd.notes[0]!.picture).toBeUndefined();
    const { quote: _q, ...noQuote } = n;
    const w2 = write(deckOf([noQuote]));
    expect(w2).toContain(`From: ${src}\n`);
    expect(w2).not.toContain("read from a picture");
  });

  it("ids are stable and follow the front only", () => {
    const a = cardId("study/decks/A.md", "What is  a set?");
    expect(a).toBe(cardId("study/decks/A.md", "What is a set?\n"));
    expect(a).not.toBe(cardId("study/decks/B.md", "What is a set?"));
    expect(a).not.toBe(cardId("study/decks/A.md", "What is a graph?"));
    expect(a.length).toBe(16);
    const d = parse("Q: same\nA: 1\n\nQ: same\nA: 2\n", "t");
    const ids = cardIds("p", d);
    expect(ids[1]).toBe(`${ids[0]}-2`);
    expect(err(() => validate(d))).toContain("ask the same thing");
  });

  it("card ids match the Rust FNV-1a 64 bit for bit", () => {
    // FNV-1a 64 of "" is the offset basis; of "a\0" computed independently.
    expect(cardId("", "")).toBe("af63bd4c8601b7df"); // FNV-1a("\0")
    expect(cardId("p", "  a   b ")).toBe(cardId("p", "a b"));
    expect(cardId("p", "a﻿b")).not.toBe(cardId("p", "a b"));
  });

  it("cloze checks", () => {
    expect(clozeAnswers("The {{c1::chromatic number::a count}} is 2")).toEqual(["chromatic number"]);
    for (const bad of ["open {{ never closed", "empty {{ }} blank", "stray }} close"]) expect(() => clozeAnswers(bad)).toThrow();
    expect(err(() => validate(deckOf([{ front: "a {{b", back: "" }])))).toContain("never closed");
    expect(() => validate(deckOf([{ front: "2 + 2 = {{4}}", back: "" }]))).not.toThrow();
  });

  it("a stray closing brace on a basic card says so with both braces (fixed)", () => {
    expect(err(() => validate(deckOf([{ front: "a }} b", back: "x" }])))).toBe("Card 1: a }} has no {{ before it.");
  });
});
