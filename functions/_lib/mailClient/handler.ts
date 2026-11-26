// The guard for every /api/mail-client/* route except login/logout: the
// mailbox-owner counterpart of @altasme/webmail-kit's mailHandler() (which
// ../mailHandler.ts pins to StaffUser for /api/app/mail/*).
//
// Why not reuse the package's mailHandler() with a client user type: it
// reads `ctx.data.staffUser` (populated only by the staff middleware) and
// resolves access via mail_account_access by users.id. Neither applies to
// a mailbox owner, who has no users row and no grants. So this guard
// resolves its own principal from its own cookie, and hands route code the
// same `{ ctx, db, user, access }` shape, so the package's query/detail/
// action functions (which only ever take `access`) work unchanged.
//
// Isolation from the staff session (see ./session.ts for the cookie-level
// reasoning):
//   - This guard reads ONLY `ck_mail_client_session`. It never reads
//     `ck_session`, never reads ctx.data.staffUser, never consults `users`
//     or mail_account_access. A valid staff session therefore grants
//     nothing here: no client cookie -> 401.
//   - The staff guard (functions/api/app/_middleware.ts) reads ONLY
//     `ck_session` and verifies it against a different signed message, so
//     a client cookie grants nothing there either (401). The client cookie
//     is also Path=/api/mail-client, so browsers don't send it to /api/app.
//   - This route tree lives under /api/mail-client/, outside
//     functions/api/app/, so the staff middleware doesn't run here and this
//     guard doesn't run there.
//
// Account scoping: the ONLY mailbox id route code ever gets is
// `account.id`, from the verified session, re-checked for eligibility
// (./account.ts) on every request. No route under /api/mail-client reads
// an account id from the URL or body.
//
// CSRF: the cookie is SameSite=Strict; on top of that every non-GET
// request must be `Content-Type: application/json` (which a cross-site
// HTML form can't send without a CORS preflight this API never answers)
// and, when the browser sends an Origin header, it must be this host.

import { errorResponse } from "@altasme/webmail-kit/http";
import type { MailAccess } from "@altasme/webmail-kit/access";
import type { MailEnv } from "@altasme/webmail-kit/config";
import { findEligibleAccountById, ownMailboxAccess, type ClientMailAccount } from "./account";
import { clearMailClientSessionCookie, verifyMailClientSessionCookie } from "./session";

export type MailClientEnv = MailEnv & { SESSION_SECRET?: string };

// Structurally satisfies the package's MailUser ({ id, role }). `id` is a
// namespaced string that can never equal a users.id (WorkOS ids look like
// "user_01..."), so any package helper that compares it against a
// created_by column (drafts, draft attachments) simply never matches.
export interface ClientMailUser {
  id: string;
  role: "client_mail";
}

export interface MailClientHandlerArgs<P extends string = string> {
  ctx: EventContext<MailClientEnv, P, Record<string, unknown>>;
  db: D1Database;
  user: ClientMailUser;
  account: ClientMailAccount;
  access: MailAccess;
}

export function clientMailActorId(accountId: string): string {
  return `mailbox:${accountId}`;
}

/** Same-origin + JSON body requirement for state-changing requests. Returns an error Response, or null when OK. */
export function rejectCrossSite(request: Request): Response | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const type = (request.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return errorResponse(415, "Expected a JSON request.");
  const origin = request.headers.get("origin");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === new URL(request.url).host;
    } catch {
      ok = false;
    }
    if (!ok) return errorResponse(403, "Cross-site request refused.");
  }
  return null;
}

function unauthenticated(clearCookie: boolean): Response {
  const res = errorResponse(401, "Not signed in.");
  if (clearCookie) res.headers.append("Set-Cookie", clearMailClientSessionCookie());
  return res;
}

export function mailClientHandler<P extends string = string>(fn: (args: MailClientHandlerArgs<P>) => Promise<Response>): PagesFunction<MailClientEnv, P> {
  return async (ctx) => {
    const db = ctx.env.DB;
    const secret = ctx.env.SESSION_SECRET;
    if (!db || !secret) return errorResponse(500, "Not configured");
    const csrf = rejectCrossSite(ctx.request);
    if (csrf) return csrf;
    try {
      const session = await verifyMailClientSessionCookie(secret, ctx.request.headers.get("Cookie"));
      if (!session) return unauthenticated(false);
      const account = await findEligibleAccountById(db, session.mailAccountId);
      // No longer eligible (deactivated, service suspended, mailbox deleted)
      // or the address on the account changed since sign-in: end the session.
      if (!account || account.emailAddress !== session.emailAddress) return unauthenticated(true);
      const user: ClientMailUser = { id: clientMailActorId(account.id), role: "client_mail" };
      return await fn({ ctx: ctx as MailClientHandlerArgs<P>["ctx"], db, user, account, access: ownMailboxAccess(account) });
    } catch (err) {
      console.error("mail-client route error", ctx.request.method, new URL(ctx.request.url).pathname, err instanceof Error ? err.stack || err.message : err);
      return errorResponse(500, "Something went wrong processing this mail request.");
    }
  };
}
