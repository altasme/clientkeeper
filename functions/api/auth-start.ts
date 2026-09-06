// Cloudflare Pages Function: GET /api/auth-start
//
// Redirects to WorkOS AuthKit's hosted authorize URL. There is no
// self-service staff signup here (CLAUDE.md §1) — a staff member's WorkOS
// account must already exist (invited via clienthub's invitation flow or
// created directly in the WorkOS dashboard) and their workos_user_id must
// already be inserted into the shared `users` table before this flow can
// grant them anything; this endpoint just gets them through WorkOS login.
//
// prompt=login forces a real login screen every time rather than silently
// reusing an existing AuthKit browser session — same reasoning as
// clienthub's identical param (see that repo's functions/api/auth-start.ts):
// on a shared/kiosk machine, or after switching which staff account is
// meant to be active, a silent session carry-over would be exactly wrong
// for a staff tool gating stage/offer mutations.
//
// Required env vars: WORKOS_CLIENT_ID.

interface Env {
  WORKOS_CLIENT_ID: string;
}

const REDIRECT_URI = "https://clientkeeper.altasme.com/api/auth-callback";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.WORKOS_CLIENT_ID) {
    return new Response("Auth is not configured yet.", { status: 500 });
  }

  const authorizeUrl = new URL("https://api.workos.com/user_management/authorize");
  authorizeUrl.searchParams.set("client_id", env.WORKOS_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("provider", "authkit");
  authorizeUrl.searchParams.set("prompt", "login");

  return Response.redirect(authorizeUrl.toString(), 302);
};
