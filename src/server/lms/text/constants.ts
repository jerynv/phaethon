/**
 * Strings and limits shared by the text copies, text recognition and the
 * material report. The copy wording is a contract between modules (the
 * material report and study code parse it): keep it byte for byte.
 */

/** A PDF page with fewer letters than this in its text layer is recognised as a picture. */
export const SPARSE = 30;
/** After a page heading: its text was recognised from its picture. */
export const RECOGNISED = "(recognised from handwriting or a scan; may contain mistakes)";
/** Under a typed page's text: it also shows pictures. */
export const PICTURES_NOTE = "(This page also shows ";
export const NO_TEXT_IN_PICTURE = "(No text was found in this picture.)";
/** What copies made before recognition worked off macOS said; made again once it works. */
export const NO_OCR = "(This page is handwriting or a scan; text recognition needs macOS for now.)";
export const NO_OCR_PICTURE = "(This is a picture; recognising any text in it needs macOS for now.)";
/** A page or picture whose text couldn't be recognised on this computer, and why. */
export const CANT_RECOGNISE = "its text can’t be recognised on this computer:";
/** The start of the note a copy of a file with no text gets (old and current wording alike). */
export const OLD_NO_TEXT = "(This file has no text in it";
/** The whole note the import writes for a document with no text. */
export const NO_TEXT_COPY = "(This file has no text in it: it may be scanned pages or pictures. Open the file itself to read it.)";

/** Largest file read whole (the download limit). */
export const MAX_READ = 300 * 1024 * 1024;
/** Largest text copy kept, in bytes. */
export const MAX_TEXT = 8 * 1024 * 1024;
/** Largest Office part read (one slide's XML, a document's body). */
export const MAX_PART = 64 * 1024 * 1024;
export const MAX_SLIDES = 1000;
export const PDF_TIMEOUT_MS = 60_000;

/** Text recognition. */
export const PAGE_TIMEOUT_MS = 90_000;
export const FILE_TIMEOUT_MS = 15 * 60_000;
/** Most pages of one PDF recognised. */
export const MAX_OCR_PAGES = 300;
/** Pages are drawn for recognition at about 300 dpi, the longest side at most this many pixels. */
export const OCR_MAX_SIDE = 4000;
export const OCR_DPI = 300;
/** Most text kept from one page, in bytes. */
export const MAX_PAGE_TEXT = 256 * 1024;

/** Page pictures for a model. */
export const PICTURE_SIDE = 1568;
export const PICTURE_BYTES = 3_500_000;
export const PICTURES_MAX = 12;
export const PICTURES_TIMEOUT_MS = 90_000;
export const PICTURE_DPI = 150;

/** Rust `char::is_alphanumeric`. */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;

/** Letters and digits in `t` (Unicode alphanumerics). */
export function letters(t: string): number {
  let n = 0;
  for (const c of t) if (ALNUM.test(c)) n++;
  return n;
}
