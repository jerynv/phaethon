import { HttpError, request } from "./http.ts";
import { kindName, type Kind, type Site } from "./types.ts";

/**
 * Before the sign-in window opens: one signed-out request to the address, to
 * tell a typo or the wrong kind of site from a real course site.
 */

export type Answer = { status: number; contentType: string; cookies: string[]; headers: string[]; body: string };

export function checkPath(kind: Kind): string {
  switch (kind) {
    case "canvas":
      return "api/v1/users/self";
    case "brightspace":
      return "d2l/api/versions/";
    case "moodle":
      return "login/index.php";
    case "blackboard":
      return "learn/api/public/v1/system/version";
  }
}

export function looksLike(kind: Kind, a: Answer): boolean {
  const body = a.body.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const cookie = (name: string) => a.cookies.some((c) => c.toLowerCase().startsWith(name));
  const header = (name: string) => a.headers.includes(name);
  const json = a.contentType.includes("json");
  switch (kind) {
    case "canvas":
      return header("x-canvas-meta") || cookie("_normandy_session") || cookie("canvas_session") || (a.status === 401 && body.includes("unauthenticated"));
    case "brightspace":
      return (json && body.includes("productcode") && body.includes("latestversion")) || cookie("d2lsessionval");
    case "moodle":
      return cookie("moodlesession") || body.includes("m.cfg") || body.includes("moodle");
    case "blackboard":
      return (json && body.includes('"learn"')) || cookie("bbrouter") || (cookie("jsessionid") && body.includes("blackboard"));
  }
}

export async function check(site: Site): Promise<void> {
  const host = site.base.hostname || "that address";
  let res;
  try {
    res = await request(site.join(checkPath(site.kind)), { connectTimeoutMs: 10_000, totalTimeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof HttpError && e.timeout) throw new Error(`${host} didn’t answer. Check the address, or try again in a moment.`);
    throw new Error(`Couldn’t reach ${host}. Check the address: it’s the one in your browser’s address bar when you open ${kindName(site.kind)}.`);
  }
  let body = "";
  try {
    body = (await res.bytes(256 * 1024)).subarray(0, 256 * 1024).toString("utf8");
  } catch {
    body = "";
  }
  const a: Answer = {
    status: res.status,
    contentType: res.header("content-type") ?? "",
    cookies: res.headerAll("set-cookie"),
    headers: res.headerNames(),
    body,
  };
  if (looksLike(site.kind, a)) return;
  if (res.status >= 500) throw new Error(`${host} is having trouble right now (it answered with an error). Try again later.`);
  throw new Error(`${host} doesn’t look like a ${kindName(site.kind)} site. Check the address, and which course site your school uses.`);
}
