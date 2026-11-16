/**
 * Course names as people read them. Course sites hand names over the way the
 * registrar stores them, "XX99: INTRO PLACEHOLDER STUDIES: 1234": a term
 * prefix, the name in capitals, a section or CRN at the end. `shortCourseName`
 * keeps the name and sets it in title case; the raw name stays on the course.
 * Pure.
 */

const TERM = String.raw`(?:(?:FA|SP|SU|WI|SM|F|S|W)\s?'?\d{2}(?:\d{2})?|\d{4}\s?(?:FA|SP|SU|WI|SM|F|S|W)|(?:Fall|Spring|Summer|Winter|Autumn)\s+\d{2,4}|\d{4}\s+(?:Fall|Spring|Summer|Winter|Autumn)|\d{6})`;
/** "FA26: ", "FA26 ", "XX99 - ", "2026FA-", "202610_", "Fall 2026: ": a term before the name. */
const TERM_PREFIX = [new RegExp(String.raw`^\[?${TERM}\]?(?:\s*[-:–—_.|/]\s*|\s+)`, "i"), /^(?=[A-Z0-9]*\d)[A-Z0-9]{2,8}\s*[:\-–—|]\s+/i];
/** "MTH-214-01 ", "BIOL 1406.003 - ", "HIS_2301_012 ": a course code before the name (capitals only, so ordinary words stay; a one-word code like "CS101" reads as part of the name and stays). */
const CODE_PREFIX = /^[A-Z]{2,5}[\s\-_]\d{3,4}[A-Z]?(?:[\s\-_.]\d{1,4}[A-Z]?)*(?:\s*[-:–—|]\s*|\s+)(?=[A-Za-z])/;

/** ": 1234", " - SEC 002", " (01)", ", section B", " (All Sections)": a section or CRN after the name (not the end of "1865-1945"). */
const SECTION_SUFFIX = [
  /(?:\s*[:|,]\s*|\s+[\-–—]\s*)\d{3,6}$/,
  /\s*\(\s*all\s+sections?\s*\)$/i,
  /\s*[:\-–—|,]?\s*\b(sec|sect|section)\.?\s*[A-Z0-9]{1,5}$/i,
  /\s*[([]\s*(?:(?:sec|sect|section)\.?\s*)?[A-Z]?\d{1,5}[A-Z]?\s*[)\]]$/i,
  // " CRN 48213", " Lec 2", " (Lecture 1)"
  /\s*[([]?\b(?:CRN|Lec(?:ture)?)\s*#?\s*[A-Z]?\d+[A-Z]?[)\]]?$/i,
  // A bare five-digit CRN at the end.
  /\s+\d{5}$/,
  // A term or a course code at the end: " - FA26", " MTH-214-01".
  new RegExp(String.raw`(?:\s*[-–—:|,]\s*|\s+)[([]?${TERM}[)\]]?$`, "i"),
  // Only an unmistakable code ("MTH-214-01", "BIO 1406.003"), so "Since 1877" stays.
  /(?:\s*[-–—:|,]\s*|\s+)[A-Z]{2,5}(?:[\-_]\d{3,4}[A-Z]?(?:[\s\-_.]\d{1,4}[A-Z]?)*|\s?\d{3,4}[A-Z]?(?:[\-_.]\d{1,4}[A-Z]?)+)$/,
];
/** What is left is only a course code: nothing readable to show instead of the raw name. */
const CODE_ONLY = /^[A-Z]{2,5}[\s\-_]?\d{3,4}[A-Z]?(?:[\s\-_.]\d{1,4}[A-Z]?)*$/;

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
  name = name.replace(CODE_PREFIX, "");
  for (let changed = true; changed; ) {
    const before = name;
    for (const re of SECTION_SUFFIX) name = name.replace(re, "");
    changed = name !== before && name.length > 0;
  }
  name = name.replace(/^[\s\-:–—_.|]+|[\s\-:–—_.|,]+$/g, "").trim();
  if (!/[a-z]{2}/i.test(name) || CODE_ONLY.test(name)) return original;
  return titleCaseName(name);
}

/** Courses in the order their short names read. */
export function byShortName<T extends { name: string }>(a: T, b: T): number {
  return shortCourseName(a.name).localeCompare(shortCourseName(b.name), undefined, { numeric: true, sensitivity: "base" });
}
