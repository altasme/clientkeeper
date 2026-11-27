// The guard for every /api/mail-connect/* DATA route (not exchange/logout,
// not admin/*): the Webmail Connect counterpart of
// ../mailClient/handler.ts's mailClientHandler().
//
// Isolation from the other two session types (cookie-level reasoning in
// ./session.ts):
//   - This guard reads ONLY `ck_mail_connect_session`. It never reads
//     `ck_session` or `ck_mail_client_session`, never reads
//     ctx.data.staffUser, never consults `users` or mail_account_access.
//     A valid staff or mailbox-owner session therefore grants nothing
//     here: no connect cookie -> 401.
//   - The staff middleware (functions/api/app/_middleware.ts) and the
//     mailbox-owner guard (../mailClient/handler.ts) each read only their
//     own cookie and verify it against their own signed message, so a
//     connect cookie grants nothing there either (401). The connect
//     cookie is Path=/api/mail-connect, so browsers don't send it there.
//   - This route tree lives under /api/mail-connect/, outside both
//     functions/api/app/ and functions/api/mail-client/, so neither of the
//     other guards runs here and this one doesn't run there.
//
// Authorization, re-derived on EVERY request: the integration must still
// be 'active', and the caller's grants are read fresh from
// mail_external_mailbox_access (./account.ts). Route code never sees
// anything cached in the session. A route that works on one mailbox takes
// an explicit mailboxId from the request (query param on reads, body on
// writes) and resolves it with requireGrant(): a mailbox not in the live
// grant list is 404 (same IDOR posture as the rest of this app); a
// mailbox that IS in the list but whose grant lacks the needed permission
// (send, delete, settings) is 403 -- the caller can already see the
// mailbox exists, so 403 leaks nothing and says what's actually wrong.
//
// CSRF: SameSite=Strict, plus the mailbox-owner API's own same-origin +
// JSON-body rule (rejectCrossSite) on every non-GET.

import { errorResponse } from "@altasme/webmail-kit/http";
import type { MailAccess } from "@altasme/webmail-kit/access";
import type { MailEnv } from "@altasme/webmail-kit/config";
import { rejectCrossSite } from "../mailClient/handler";
import { accessFor, findActiveIntegration, grantAllows, loadLiveGrants, type ConnectGrant, type ConnectIntegration, type ConnectPermission } from "./account";
import { clearMailConnectSessionCookie, verifyMailConnectSessionCookie, type MailConnectSessionPayload } from "./session";

export type MailConnectEnv = MailEnv & { SESSION_SECRET?: string };

// Structurally satisfies the package's MailUser ({ id, role }). The id is
// namespaced so it can never equal a users.id; any package helper that
// compares it against a created_by column (drafts) never matches.
export interface ConnectMailUser {
  id: string;
  role: "mail_connect";
}

export interface MailConnectHandlerArgs<P extends string = string> {
  ctx: EventContext<MailConnectEnv, P, Record<string, unknown>>;
  db: D1Database;
  session: MailConnectSessionPayload;
  integration: ConnectIntegration;
  user: ConnectMailUser;
  /** The caller's usable grants, read from the database for THIS request. */
  grants: ConnectGrant[];
  unavailableCount: number;
}

/** mail_events.actor_id for anything a connect user does. */
export function connectActorId(integrationId: string, externalUserId: string): string {
  return `connect:${integrationId}:${externalUserId}`;
}

export type GrantResolution = { ok: true; grant: ConnectGrant; access: MailAccess } | { ok: false; response: Response };

/**
 * Resolves the request's mailboxId against the caller's LIVE grants.
 * Not granted -> 404. Granted without `permission` -> 403. On success,
 * `access` is a one-entry map holding only that mailbox, which is what
 * confines every package call to it.
 */
export function requireGrant(grants: ConnectGrant[], mailboxId: unknown, permission: ConnectPermission = "read"): GrantResolution {
  const id = typeof mailboxId === "string" ? mailboxId : "";
  const grant = id ? grants.find((g) => g.mailAccountId === id) : undefined;
  if (!grant || !grantAllows(grant, "read")) return { ok: false, response: errorResponse(404, "Mailbox not found.") };
  if (!grantAllows(grant, permission)) {
    const message =
      permission === "send"
        ? grant.canSend
          ? "Sending is disabled for this mailbox."
          : "You have read-only access to this mailbox."
        : permission === "delete"
          ? "You don't have permission to delete mail in this mailbox."
          : "You don't have permission to change this mailbox's settings.";
    return { ok: false, response: errorResponse(403, message) };
  }
  return { ok: true, grant, access: accessFor([grant]) };
}

function unauthenticated(clearCookie: boolean): Response {
  const res = errorResponse(401, "Not signed in.");
  if (clearCookie) res.headers.append("Set-Cookie", clearMailConnectSessionCookie());
  return res;
}

export function mailConnectHandler<P extends string = string>(fn: (args: MailConnectHandlerArgs<P>) => Promise<Response>): PagesFunction<MailConnectEnv, P> {
  return async (ctx) => {
    const db = ctx.env.DB;
    const secret = ctx.env.SESSION_SECRET;
    if (!db || !secret) return errorResponse(500, "Not configured");
    const csrf = rejectCrossSite(ctx.request);
    if (csrf) return csrf;
    try {
      const session = await verifyMailConnectSessionCookie(secret, ctx.request.headers.get("Cookie"));
      if (!session) return unauthenticated(false);
      // Disabled or deleted integration: end the session.
      const integration = await findActiveIntegration(db, session.integrationId);
      if (!integration) return unauthenticated(true);
      const { grants, unavailableCount } = await loadLiveGrants(db, integration.id, session.externalUserId);
      const user: ConnectMailUser = { id: connectActorId(integration.id, session.externalUserId), role: "mail_connect" };
      return await fn({ ctx: ctx as MailConnectHandlerArgs<P>["ctx"], db, session, integration, user, grants, unavailableCount });
    } catch (err) {
      console.error("mail-connect route error", ctx.request.method, new URL(ctx.request.url).pathname, err instanceof Error ? err.stack || err.message : err);
      return errorResponse(500, "Something went wrong processing this mail request.");
    }
  };
}
