import type { Connection, LmsKind } from "@/lib/lms";

/** The four course sites, in the order they are offered, with where people usually find theirs. */
export const KINDS: { kind: LmsKind; label: string; hint: string; example: string }[] = [
  { kind: "canvas", label: "Canvas", hint: "Usually canvas.<school>.edu or <school>.instructure.com", example: "canvas.yourschool.edu" },
  { kind: "brightspace", label: "Brightspace (D2L)", hint: "Usually <school>.brightspace.com or d2l.<school>.edu", example: "yourschool.brightspace.com" },
  { kind: "moodle", label: "Moodle", hint: "Usually moodle.<school>.edu or <school>.moodlecloud.com", example: "moodle.yourschool.edu" },
  { kind: "blackboard", label: "Blackboard", hint: "Usually <school>.blackboard.com or learn.<school>.edu", example: "learn.yourschool.edu" },
];

export const kindLabel = (k: LmsKind) => KINDS.find((x) => x.kind === k)?.label ?? k;

/** The site's host, for showing: "iu.instructure.com". */
export function hostOf(address: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(address) ? address : `https://${address}`).host;
  } catch {
    return address;
  }
}

/** What a connection is called: its school's name when known, its address otherwise. */
export const connectionName = (c: Pick<Connection, "schoolName" | "address">) => c.schoolName || hostOf(c.address);

/**
 * Check an address typed by hand, as the core will (an https origin): the
 * origin to connect to, or what is wrong with it in plain words.
 */
export function checkAddress(raw: string, example: string): { ok: true; address: string } | { ok: false; problem: string } {
  const text = raw.trim();
  if (!text) return { ok: false, problem: `Type your course site’s address, for example ${example}.` };
  if (/\s/.test(text)) return { ok: false, problem: `An address has no spaces. It looks like ${example}.` };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme && scheme !== "https") {
    return { ok: false, problem: "Phaethon only connects to secure addresses, the ones that start with https://. Copy the address from your browser." };
  }
  let u: URL;
  try {
    u = new URL(scheme ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: `That doesn’t look like a web address. It looks like ${example}.` };
  }
  if (u.username || u.password) return { ok: false, problem: "Leave your name and password out of the address. You sign in on the next step." };
  if (!u.hostname.includes(".") || u.hostname.endsWith(".")) {
    return { ok: false, problem: `That address is missing its ending (like .edu or .com). It looks like ${example}.` };
  }
  return { ok: true, address: u.origin };
}

/** True when an error from the core means the session has expired. */
export const isSignedOut = (e: unknown) => /signed ?out/i.test(String(e));
/** True when the sign-in window was closed before signing in. */
export const isCancelled = (e: unknown) => String(e).trim().toLowerCase() === "cancelled";

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "10 Oct, 14:02", with the year when it isn't this one. */
export function whenText(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...(sameYear ? {} : { year: "numeric" }) });
}
