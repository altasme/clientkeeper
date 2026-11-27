// GET /api/mail-connect/exchange?code=... -- where the browser lands after
// a client admin panel asked for a launch (./admin.ts, launchRoute). Turns
// a single-use launch code into a Webmail Connect session cookie and
// redirects to /mail/connect.
//
// Single use, even under concurrency: the code is claimed with ONE
// conditional UPDATE (status 'pending' AND not expired -> 'used'); only the
// request whose UPDATE changed a row gets a session. Same claim-in-one-
// statement approach as mail_request_links ('open' -> 'used') and the
// entitlement engine's slot reservation.
//
// Lookup: the code is `<launch id>.<64 hex>`. The row is found by id and
// the full stored code compared in constant time (the same "readable
// handle + constant-time token compare" convention as every other public
// token route in this app), so the database lookup itself never depends
// on the secret part.
//
// Every failure (malformed, unknown, wrong secret part, already used,
// expired, integration disabled) looks the same: no session, any existing
// connect cookie cleared, and a redirect to /mail/connect?error=link,
// whose page says "this link is invalid or has expired". Nothing in the
// redirect reveals which check failed, and nothing sensitive is ever put
// in the redirect URL: on success the cookie is already set.

import { logMailEvent } from "@altasme/webmail-kit/events";
import { errorResponse } from "@altasme/webmail-kit/http";
import { timingSafeEqual } from "../crypto";
import { findActiveIntegration } from "./account";
import { connectActorId, type MailConnectEnv } from "./handler";
import { clearMailConnectSessionCookie, createMailConnectSessionCookie } from "./session";

const CODE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}$/;
export const CONNECT_PAGE_PATH = "/mail/connect";

function redirect(location: string, setCookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": setCookie,
      "cache-control": "no-store",
      // The exchange URL carried the code; never pass it on as a Referer.
      "referrer-policy": "no-referrer",
    },
  });
}

const failure = () => redirect(`${CONNECT_PAGE_PATH}?error=link`, clearMailConnectSessionCookie());

export async function handleExchange(ctx: { request: Request; env: MailConnectEnv }, now: () => number = Date.now): Promise<Response> {
  const db = ctx.env.DB;
  const secret = ctx.env.SESSION_SECRET;
  if (!db || !secret) return errorResponse(500, "Not configured");
  try {
    const code = new URL(ctx.request.url).searchParams.get("code") ?? "";
    const parsed = CODE_RE.exec(code);
    if (!parsed) return failure();
    const id = parsed[1]!;
    const row = await db
      .prepare(`SELECT id, integration_id, external_user_id, code FROM mail_launch_codes WHERE id = ?`)
      .bind(id)
      .first<{ id: string; integration_id: string; external_user_id: string; code: string }>();
    if (!row || !timingSafeEqual(row.code, code)) return failure();

    const nowIso = new Date(now()).toISOString();
    const claimed = await db
      .prepare(`UPDATE mail_launch_codes SET status = 'used', used_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`)
      .bind(nowIso, id, nowIso)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      // Housekeeping only: record that an unclaimed code ran out.
      await db.prepare(`UPDATE mail_launch_codes SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?`).bind(id, nowIso).run();
      return failure();
    }

    // Checked after the claim, so a disabled integration's code is burned too.
    const integration = await findActiveIntegration(db, row.integration_id);
    if (!integration) return failure();

    const cookie = await createMailConnectSessionCookie(secret, { integrationId: integration.id, externalUserId: row.external_user_id, launchId: row.id });
    await logMailEvent(db, {
      accountId: null,
      messageId: null,
      type: "connect_session_started",
      data: { integrationId: integration.id, externalUserId: row.external_user_id, launchId: row.id },
      actorId: connectActorId(integration.id, row.external_user_id),
    });
    return redirect(CONNECT_PAGE_PATH, cookie);
  } catch (err) {
    console.error("mail-connect exchange error", err instanceof Error ? err.message : "unknown");
    return failure();
  }
}
