/**
 * Course names as people say them. Course sites hand names over the way their
 * registrar stores them: a term code in front ("XX99: "), a section or CRN
 * after (": 1234", "(All Sections)"), often in capitals. `shortCourseName`
 * drops those parts and gives names in capitals ordinary case, keeping course
 * codes, roman numerals and common acronyms as they are.
 */

// A term code: two letters and a two-digit year ("XX99"), the year first ("2026FA", "202610"), or a season and year.
const TERM = /^(?:[A-Z]{1,2}\d{2}|[A-Z]{2}\d{4}|\d{4}[A-Z]{1,2}|\d{6}|(?:fall|spring|summer|winter|autumn)\s+\d{4})\s*[:|–—-]\s*/i;
const TAIL = [
  // ": 1234", " - 001" (not the end of "1865-1945")
  /(?::\s*|\s+[|–—-]\s*)\d{3,6}$/,
  // "(All Sections)", "(Section 02)", "(Sec 1, 2)", "(1234)"
  /\s*\((?:all\s+sections?|sec(?:tion)?s?\.?\s*[\w\s,&-]*|\d[\d\s,&-]*)\)$/i,
  // " Section 02", " Sec. 3"
  /\s+sec(?:tion)?\.?\s*\d+[a-z]?$/i,
];

const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "via", "with"]);
const ACRONYMS = new Set(["AI", "AP", "API", "CAD", "CPR", "DNA", "EMT", "ESL", "EU", "GIS", "HIV", "IB", "LGBTQ", "ROTC", "RNA", "STEM", "UI", "UK", "UN", "US", "USA", "UX"]);
const ROMAN = /^(?:I{1,3}|IV|V|VI{1,3}|IX|X|XI{1,2})$/;

function word(w: string, first: boolean, next: string | undefined): string {
  const bare = w.replace(/[^A-Za-z]/g, "");
  if (!bare) return w;
  // Kept in capitals: roman numerals, known acronyms, letters with no vowels (CS, HTML), and a subject code before its number (MTH 214).
  if (ROMAN.test(bare) || ACRONYMS.has(bare) || !/[AEIOUY]/i.test(bare) || /\d/.test(w)) return w;
  if (bare.length <= 4 && next && /^\d/.test(next)) return w;
  const lower = w.toLowerCase();
  if (!first && SMALL.has(lower)) return lower;
  // Each part of "SOCIO-ECONOMIC" or "ART/DESIGN"; "WOMEN'S" stays "Women's".
  return lower.replace(/(^|[-/(“"])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

function titleCase(s: string): string {
  const parts = s.split(/(\s+)/);
  const words = parts.filter((p) => p.trim());
  let i = 0;
  return parts
    .map((p) => {
      if (!p.trim()) return p;
      const out = word(p, i === 0 || /[:–—-]$/.test(words[i - 1] ?? ""), words[i + 1]);
      i++;
      return out;
    })
    .join("");
}

/** "XX99: INTRO PLACEHOLDER STUDIES: 1234" → "Intro Placeholder Studies". Falls back to the name as given when nothing would be left. */
export function shortCourseName(raw: string): string {
  const given = raw.replace(/\s+/g, " ").trim();
  let s = given.replace(TERM, "");
  for (let before = ""; before !== s; ) {
    before = s;
    for (const t of TAIL) s = s.replace(t, "");
    s = s.replace(/[\s:|,–—-]+$/, "");
  }
  if (!/[A-Za-z]/.test(s)) s = given;
  return /[a-z]/.test(s) || !/[A-Z]/.test(s) ? s : titleCase(s);
}
