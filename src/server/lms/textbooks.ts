import { scan, type FoundLink } from "./html.ts";

/** Textbooks a course names: ISBNs in its text, and links that look like the course's book. */

export type Isbn = { isbn: string; line: string };

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isbn10Ok(d: string): boolean {
  if (d.length !== 10 || ![...d.slice(0, 9)].every(isDigit) || !(isDigit(d[9]) || d[9] === "X")) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * (d[i] === "X" ? 10 : Number(d[i]));
  return sum % 11 === 0;
}

function isbn13Ok(d: string): boolean {
  if (d.length !== 13 || ![...d].every(isDigit) || !(d.startsWith("978") || d.startsWith("979"))) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(d[i]);
  return sum % 10 === 0;
}

/** Every valid ISBN in `text` (ISBN-10 only right after the word "ISBN"), with its line. */
export function isbns(text: string): Isbn[] {
  const out: Isbn[] = [];
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  for (const line of lines) {
    const chars = [...line];
    let i = 0;
    while (i < chars.length) {
      if (!isDigit(chars[i])) {
        i++;
        continue;
      }
      const start = i;
      let j = i;
      while (j < chars.length && (isDigit(chars[j]) || ["-", " ", "‐", "–", "X", "x"].includes(chars[j]))) j++;
      const run = chars.slice(start, j).join("");
      const parts = run.split(" ").filter((p) => p !== "");
      const prefix = chars
        .slice(Math.max(0, start - 16), start)
        .join("")
        .toLowerCase();
      const afterIsbn = prefix.includes("isbn");
      for (let a = 0; a < parts.length; a++) {
        for (let b = a; b < parts.length; b++) {
          const digits = parts
            .slice(a, b + 1)
            .join("")
            .split("")
            .filter((c) => isDigit(c) || c === "X" || c === "x")
            .map((c) => c.toUpperCase())
            .join("");
          if (digits.length > 13) break;
          const found = isbn13Ok(digits) || (a === 0 && afterIsbn && isbn10Ok(digits));
          if (found && !out.some((x) => x.isbn === digits)) out.push({ isbn: digits, line: [...line.trim()].slice(0, 240).join("") });
        }
      }
      i = Math.max(j, i + 1);
    }
  }
  return out;
}

const TEXTBOOK_WORDS = [
  "textbook",
  "text book",
  "required text",
  "required reading",
  "course text",
  "course materials",
  "required materials",
  "isbn",
  "open textbook",
  "e-book",
  "ebook",
  "edition",
  "course reader",
  "course pack",
  "coursepack",
];

const OPEN_HOSTS = ["openstax.org", "libretexts.org", "open.umn.edu", "pressbooks.pub", "opentextbc.ca", "oercommons.org", "oer.galileo.usg.edu", "openoregon.pressbooks.pub", "saylor.org"];

export function openTextbookHost(u: URL): boolean {
  const host = u.hostname.replace(/\.+$/, "").toLowerCase();
  if (!host) return false;
  return OPEN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isTextbook(link: FoundLink): boolean {
  const words = `${link.text} ${link.context}`.toLowerCase();
  return openTextbookHost(link.url) || TEXTBOOK_WORDS.some((w) => words.includes(w));
}

/** On a book's page: the first link to a .pdf, else one whose words say PDF or download. */
export function pdfLinkOnPage(pageHtml: string, pageUrl: URL): URL | null {
  const s = scan(pageHtml, pageUrl);
  const web = (u: URL) => u.protocol === "http:" || u.protocol === "https:";
  const byAddress = s.links.find((l) => web(l.url) && l.url.pathname.toLowerCase().endsWith(".pdf"));
  if (byAddress) return byAddress.url;
  const byWords = s.links.find((l) => {
    const t = l.text.toLowerCase();
    return web(l.url) && (t.includes("pdf") || (t.includes("download") && !t.includes("app")));
  });
  return byWords ? byWords.url : null;
}
