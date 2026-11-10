import { describe, expect, it } from "vitest";
import { context, find, locate, near, pageAt, pageText, roughly, unusable } from "./quote.ts";

const PDF =
  "## Page 1\n\nc\n1\n:\nR\n→\nR\n defined by\nc\n1\n(\nx\n)\n=\nx\n3\n−\n10\n.  Is\nc\n1\n injective?\n\n5.3 Properties of Functions\n\nA function f is injective (or \u201cone-to-one\u201d) if no two inputs give the same out- put.";

const RECOGNISED_PAGE =
  "## Page 2\n\nx\n\n## Page 3 (recognised from handwriting or a scan; may contain mistakes)\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R\nIt is symmetric if whenever (a,b) € R then (b, a) E R\nTransitive: if (a,b) eR and (b,c) e R then (a,c) € R\nequivalance relation = reflexive, symmetric, transitive\n\n## Page 4\n\nnext";

describe("quote", () => {
  it("exact_and_whitespace_insensitive", () => {
    expect(find(PDF, "A function f is injective")).not.toBeNull();
    const f = find(PDF, "c 1 : R → R defined by c 1 ( x ) = x 3 − 10")!;
    const hit = PDF.slice(f.start, f.end);
    expect(hit.startsWith("c") && hit.endsWith("10")).toBe(true);
    expect(find(PDF, 'injective (or "one-to-one") if no two inputs give the same output.')).not.toBeNull();
    expect(find(PDF, "c1 : R -> R")).toBeNull();
  });

  it("a_quote_read_from_a_picture_matches_its_recognised_page_roughly", () => {
    const page = pageText(RECOGNISED_PAGE, 3)!;
    expect(page.startsWith("A relation R on a set A is reflexive")).toBe(true);
    expect(page.includes("next")).toBe(false);
    expect(pageText(RECOGNISED_PAGE, 9)).toBeNull();
    expect(pageAt(RECOGNISED_PAGE, RECOGNISED_PAGE.indexOf("Transitive"))).toBe(3);
    expect(pageAt(RECOGNISED_PAGE, 0)).toBeNull();
    expect(roughly(page, "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R")).toBe(true);
    expect(roughly(page, "An equivalence relation is reflexive, symmetric and transitive")).toBe(true);
    expect(roughly(page, "A function is surjective when every element of the codomain is hit")).toBe(false);
    expect(roughly(page, "reflexive symmetric")).toBe(false);
    expect(find(page, "An equivalence relation is reflexive, symmetric and transitive")).toBeNull();
    expect(near("equivalence", "equivalance", 1)).toBe(true);
    expect(near("relation", "function", 2)).toBe(false);
  });

  it("missing_short_and_ellipses", () => {
    expect(find(PDF, "A function f is surjective if every output is hit")).toBeNull();
    expect(unusable("is f")).toBe("is too short to check");
    expect(find(PDF, "Properties")).toBeNull();
    expect(find(PDF, "\u201cA function f is injective … the same out- put.\u201d")).not.toBeNull();
    expect(find(PDF, "A function f is injective ... inputs give the same nothing")).toBeNull();
    expect(unusable("word ".repeat(400))).not.toBeNull();
  });

  it("the_passage_around_a_match_and_where_it_is", () => {
    const f = find(PDF, "if no two inputs give the same")!;
    const [before, hit, after] = context(PDF, f, 40);
    expect(hit).toBe("if no two inputs give the same");
    expect(before.endsWith("one-to-one\u201d) ")).toBe(true);
    expect(after.startsWith(" out- put")).toBe(true);
    expect(find("Test 1 will **not** cover graphs.", "Test 1 will not cover graphs")).not.toBeNull();
    expect(locate(PDF, f.start, false)).toBe("§5.3");
    const toc = "Contents 5 Functions 116 5.3 Properties of Functions . . . 117\n\n5.4 Functions on Sets\n\nLet's look at examples of functions on sets.";
    expect(locate(toc, toc.indexOf("Let's"), false)).toBe("§5.4");
    const hw = "Problems\n1.\nFor this problem, use these.\n2.\nHere are several functions.\n3.\nAnswer each question about c.";
    expect(locate(hw, hw.indexOf("Answer each"), true)).toBe("#3");
    expect(locate(hw, 3, true)).toBeNull();
    const long = `5.1 Sets\n\n${"• item ".repeat(3_000)}A passage here.`;
    expect(locate(long, long.indexOf("A passage"), false)).toBeNull();
    // 12,000 bytes back from just after the first bullet lands inside an "é".
    const mixed = "é".repeat(7_000) + "•".repeat(10);
    expect(locate(mixed, 7_001, false)).toBeNull();
    expect(locate(mixed, 7_001, true)).toBeNull();
  });
});
