// Cloudflare Pages Functions middleware, scoped to everything under
// /api/app/* by directory placement (the file-based router applies a
// _middleware.ts to its own directory and subdirectories only — routes
// under /api/auth-* are untouched by this, since they must be reachable
// without a session to begin with).
//
// This is the ONLY gate every data endpoint in this app needs, per
// CLAUDE.md §0/§4: "Every route in this app requires an authenticated,
// role-checked WorkOS session." Two checks, both mandatory:
//   1. A valid, unexpired session cookie (functions/_lib/session.ts).
//   2. A matching row in the shared D1 `users` table with a role
//      (functions/_lib/roles.ts) — re-queried on every request, never
//      trusted from the cookie, so a revoked staff member loses access on
//      their very next request rather than at cookie expiry.
// Missing either -> the request never reaches a route handler. No
// endpoint under /api/app/* needs to repeat this check itself.

import { verifySessionCookie } from "../../_lib/session";
import { getStaffUser, type StaffUser } from "../../_lib/roles";

interface Env {
  SESSION_SECRET: string;
  DB?: D1Database;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

export const onRequest: PagesFunction<Env, string, { staffUser: StaffUser }> = async ({
  request,
  env,
  data,
  next,
}) => {
  if (!env.SESSION_SECRET || !env.DB) {
    return jsonError(500, "Not configured");
  }

  const session = await verifySessionCookie(env.SESSION_SECRET, request.headers.get("Cookie"));
  if (!session) {
    return jsonError(401, "Not authenticated");
  }

  const staffUser = await getStaffUser(env.DB, session.workosUserId);
  if (!staffUser) {
    return jsonError(403, "No staff role configured for this account");
  }

  data.staffUser = staffUser;

  return next();
};
