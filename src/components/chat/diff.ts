/** One line of a line diff: kept, removed (only in the old file) or added (only in the new one). */
export type DiffLine = { kind: "same" | "removed" | "added"; text: string };

/** Above this many cells the middle is shown as replaced wholesale (keeps a huge diff from freezing the window). */
const MAX_CELLS = 4_000_000;

const splitLines = (s: string) => {
  const lines = s.split("\n");
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * A line diff between two texts: the common start and end kept as they are,
 * the middle by longest common subsequence.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle: DiffLine[];
  if (midA.length * midB.length > MAX_CELLS) {
    middle = [
      ...midA.map((text): DiffLine => ({ kind: "removed", text })),
      ...midB.map((text): DiffLine => ({ kind: "added", text })),
    ];
  } else {
    // lcs[i][j]: the longest common run of midA[i..] and midB[j..].
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: "same", text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) middle.push({ kind: "removed", text: midA[i++] });
      else middle.push({ kind: "added", text: midB[j++] });
    }
    while (i < n) middle.push({ kind: "removed", text: midA[i++] });
    while (j < m) middle.push({ kind: "added", text: midB[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** A diff with long unchanged stretches folded: `context` lines kept around each change. */
export type DiffRow = DiffLine | { kind: "fold"; count: number };

export function foldDiff(lines: DiffLine[], context = 3): DiffRow[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = true;
  });
  const rows: DiffRow[] = [];
  let folded = 0;
  lines.forEach((l, i) => {
    if (l.kind !== "same" || near[i]) {
      if (folded) rows.push({ kind: "fold", count: folded });
      folded = 0;
      rows.push(l);
    } else folded++;
  });
  if (folded) rows.push({ kind: "fold", count: folded });
  return rows;
}

/** "3 lines removed, 5 added" in plain words. */
export function diffSummary(lines: DiffLine[]): string {
  const removed = lines.filter((l) => l.kind === "removed").length;
  const added = lines.filter((l) => l.kind === "added").length;
  if (!removed && !added) return "No lines change.";
  const n = (k: number, w: string) => `${k} line${k === 1 ? "" : "s"} ${w}`;
  if (!removed) return `${n(added, "added")}.`;
  if (!added) return `${n(removed, "removed")}.`;
  return `${n(removed, "removed")}, ${added} added.`;
}
