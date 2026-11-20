import { TELEMETRY_UUID } from "../../src/shared/telemetry.ts";
import { authenticate, login, logout } from "./auth.ts";
import type { Env } from "./bindings.ts";
import { eventDetail, exportEvents, listEvents, overview } from "./events.ts";
import { errorResponse, HttpError, json, withSecurityHeaders } from "./http.ts";
import { ingest } from "./ingest.ts";
import { maintain } from "./maintain.ts";
import { staffRoute } from "./staff.ts";

const EVENT_PATH = "/api/events/";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  if (pathname !== "/api" && !pathname.startsWith("/api/")) {
    return env.ASSETS
      ? env.ASSETS.fetch(request)
      : new Response("Console assets unavailable", { status: 404 });
  }
  if (method === "POST" && pathname === "/api/ingest") return ingest(request, env);
  if (method === "POST" && pathname === "/api/login") return login(request, env);

  const session = await authenticate(request, env);
  if (method === "GET" && pathname === "/api/session") {
    return json({ email: session.email, role: session.role });
  }
  if (pathname === "/api/staff" || pathname.startsWith("/api/staff/")) {
    return staffRoute(request, env, session);
  }
  if (method === "POST" && pathname === "/api/logout") return logout(request, env, session);

  if (method !== "GET") throw new HttpError(405);
  if (pathname === "/api/overview") return overview(url, env);
  if (pathname === "/api/events") return listEvents(url, env);
  if (pathname === "/api/export") return exportEvents(url, env);
  const eventId = pathname.startsWith(EVENT_PATH) ? pathname.slice(EVENT_PATH.length) : null;
  if (eventId !== null && TELEMETRY_UUID.test(eventId)) return eventDetail(env, eventId);
  throw new HttpError(404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      response = errorResponse(error);
    }
    return withSecurityHeaders(request, response);
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await maintain(env);
  },
};
