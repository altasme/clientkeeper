// Cloudflare Pages Function: GET /api/auth-callback
//
// WorkOS AuthKit redirects here with a `code` after a staff member
// completes login (the registered redirect_uri for /api/auth-start).
// Exchanges the code for the authenticated user, then looks them up in the
// shared D1 `users` table by their WorkOS user id (functions/_lib/roles.ts)
// — this is the second, mandatory half of CLAUDE.md §1's two-step check.
// A successful WorkOS login with no matching `users` row is rejected
// outright: this app grants nothing from WorkOS identity alone, since
// there is no self-service staff signup and roles are assigned here
// manually, not in WorkOS.
//
// Required env vars: WORKOS_API_KEY, WORKOS_CLIENT_ID, SESSION_SECRET, DB.

import { exchangeAuthorizationCode } from "../_lib/workos";
import { getStaffUser } from "../_lib/roles";
import { createSessionCookie } from "../_lib/session";

interface Env {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  SESSION_SECRET: string;
  DB?: D1Database;
}

const HOME_URL = "https://clientkeeper.altasme.com/";

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const authError = url.searchParams.get("error");

  if (authError || !code || !env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID || !env.SESSION_SECRET || !env.DB) {
    if (authError) console.error("WorkOS returned an error on callback:", authError);
    return redirect(`${HOME_URL}?error=auth_failed`);
  }

  let user;
  try {
    user = await exchangeAuthorizationCode(env.WORKOS_API_KEY, env.WORKOS_CLIENT_ID, code);
  } catch (err) {
    console.error("WorkOS authenticate request failed", err);
    return redirect(`${HOME_URL}?error=auth_failed`);
  }

  let staffUser;
  try {
    staffUser = await getStaffUser(env.DB, user.id);
  } catch (err) {
    console.error("Failed to look up staff user", err);
    return redirect(`${HOME_URL}?error=auth_failed`);
  }

  if (!staffUser) {
    // Guardrail: a real WorkOS login with no matching `users` row grants
    // nothing. Most likely this is a client account (WorkOS is shared
    // across both apps' user pools) or a staff member whose `users` row
    // hasn't been inserted yet — either way, never provision access from
    // identity alone.
    console.error(`auth-callback: no staff user row for workos user ${user.id} (${user.email})`);
    return redirect(`${HOME_URL}?error=not_staff`);
  }

  const cookie = await createSessionCookie(env.SESSION_SECRET, {
    workosUserId: user.id,
    issuedAt: Date.now(),
  });

  return redirect(`${HOME_URL}?welcome=1`, cookie);
};
