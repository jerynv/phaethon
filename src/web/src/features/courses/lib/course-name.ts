/**
 * Course names as people read them. Course sites hand names over the way the
 * registrar stores them, "XX99: INTRO PLACEHOLDER STUDIES: 1234": a term
 * prefix, the name in capitals, a section or CRN at the end. `shortCourseName`
 * keeps the name and sets it in title case; the raw name stays on the course.
 * Pure.
 */

/** "FA26: ", "XX99 - ", "202610: ", "Fall 2026: ": a term before the name. */
const TERM_PREFIX = [/^(?=[A-Z0-9]*\d)[A-Z0-9]{2,8}\s*[:\-–—|]\s+/i, /^(fall|spring|summer|winter|autumn)\s+\d{2,4}\s*[:\-–—|]\s*/i];

/** ": 1234", " - SEC 002", " (01)", ", section B", " (All Sections)": a section or CRN after the name (not the end of "1865-1945"). */
const SECTION_SUFFIX = [
  /(?:\s*[:|,]\s*|\s+[\-–—]\s*)\d{3,6}$/,
  /\s*\(\s*all\s+sections?\s*\)$/i,
  /\s*[:\-–—|,]?\s*\b(sec|sect|section)\.?\s*[A-Z0-9]{1,5}$/i,
  /\s*[([]\s*(?:(?:sec|sect|section)\.?\s*)?[A-Z]?\d{1,5}[A-Z]?\s*[)\]]$/i,
];

const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "per", "the", "to", "via", "vs", "with"]);
const ROMAN = /^(?=[IVX])X{0,3}(IX|IV|V?I{0,3})$/;
/** Acronyms with a vowel, which the vowel rule below can't tell from words. */
const ACRONYMS = new Set(["AI", "ASL", "DNA", "ESL", "EU", "GIS", "PE", "RNA", "STEM", "UK", "UN", "US", "USA"]);

/** Kept in capitals: roman numerals, known acronyms, words with a digit ("CS101", "3D") and words without a vowel ("HTML", "SQL"). */
function staysUpper(word: string) {
  return ROMAN.test(word) || ACRONYMS.has(word) || /\d/.test(word) || !/[AEIOUY]/.test(word);
}

function titleWord(word: string, first: boolean, next: string | undefined) {
  const bare = word.replace(/[^A-Z0-9]/g, "");
  if (bare && staysUpper(bare) && /^[^A-Za-z]*[A-Z0-9]+[^A-Za-z]*$/.test(word)) return word;
  // A subject code before its number ("XYZ 214") stays as it is.
  if (bare.length > 0 && bare.length <= 4 && /^[A-Z]+$/.test(bare) && next && /^\d/.test(next)) return word;
  const lower = word.toLowerCase();
  if (!first && SMALL.has(lower)) return lower;
  // "FIRST-YEAR" → "First-Year", "WOMEN'S" → "Women's".
  return lower.replace(/(^|[-/])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** Title case for a name that arrived in capitals; a name with any lowercase letter is left as it is. */
export function titleCaseName(name: string): string {
  if (/[a-z]/.test(name) || !/[A-Z]/.test(name)) return name;
  const words = name.split(" ");
  // A small word is capitalised at the start and after a colon or dash ("Physics: An Introduction").
  return words.map((w, i) => titleWord(w, i === 0 || /[:\-–—]$/.test(words[i - 1] ?? ""), words[i + 1])).join(" ");
}

/** "XX99: INTRO PLACEHOLDER STUDIES: 1234" → "Intro Placeholder Studies". Falls back to the raw name when no words would be left. */
export function shortCourseName(raw: string): string {
  const original = raw.trim().replace(/\s+/g, " ");
  let name = original;
  for (const re of TERM_PREFIX) name = name.replace(re, "");
  for (let changed = true; changed; ) {
    const before = name;
    for (const re of SECTION_SUFFIX) name = name.replace(re, "");
    changed = name !== before && name.length > 0;
  }
  name = name.trim();
  if (!/[a-z]/i.test(name)) return original;
  return titleCaseName(name);
}

/** Courses in the order their short names read. */
export function byShortName<T extends { name: string }>(a: T, b: T): number {
  return shortCourseName(a.name).localeCompare(shortCourseName(b.name), undefined, { numeric: true, sensitivity: "base" });
}
