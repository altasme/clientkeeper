// The integration-facing, server-to-server half of Webmail Connect:
// /api/mail-connect/admin/* (grants + launch). Called by a client admin
// panel's BACKEND (via @altasme/webmail-connect), never by a browser.
//
// Authentication: `Authorization: Bearer wmc_<integrationId>_<64 hex>`.
// The integration id is parsed out of the secret, its row loaded, and
// SHA-256(secret) compared in constant time with secret_hash. A wrong
// secret, an unknown integration, a malformed header and a DISABLED
// integration all get the same 401 body, so a disabled integration can't
// be told apart from a nonexistent one by its own caller. The secret is
// never logged, never echoed, never put in any response or error.
//
// No cookie is read here, and no CORS is ever answered: a browser page on
// another origin can't call these routes with a secret it shouldn't have
// anyway, and a same-origin browser has no bearer secret.
//
// Tenant boundary: every grant is resolved through findGrantableMailbox()
// (./account.ts), i.e. only this integration's own client's hosted
// mailboxes or ones Altaventures staff attached to it. Any other address
// is "Mailbox not found." -- the same answer as an address that doesn't
// exist, so an integration can't probe for other clients' mailboxes.

import { isValidEmail, normalizeEmail } from "@altasme/webmail-kit/address";
import { errorResponse, jsonResponse, readJsonBody } from "@altasme/webmail-kit/http";
import { logMailEvent } from "@altasme/webmail-kit/events";
import { timingSafeEqual } from "../crypto";
import { GRANTABLE_CONDITION, findGrantableMailbox, findIntegration, type ConnectIntegration } from "./account";
import { connectActorId, type MailConnectEnv } from "./handler";

export const LAUNCH_CODE_TTL_MS = 60 * 1000;
const SECRET_RE = /^wmc_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{64})$/;
const MAX_EXTERNAL_USER_ID = 200;
const MAX_RETURN_URL = 2000;
const NOT_AUTHENTICATED = "Invalid integration credentials.";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh secret for an integration, plus the hash to store. The raw secret must only ever be shown once. */
export async function generateIntegrationSecret(integrationId: string): Promise<{ secret: string; hash: string }> {
  const secret = `wmc_${integrationId}_${randomHex(32)}`;
  return { secret, hash: await sha256Hex(secret) };
}

/** The ACTIVE integration a bearer header proves, or null. Exported for tests. */
export async function authenticateIntegration(db: D1Database, authorization: string | null): Promise<ConnectIntegration | null> {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/.exec(authorization.trim());
  if (!m) return null;
  const secret = m[1]!;
  const parsed = SECRET_RE.exec(secret);
  if (!parsed) return null;
  const row = await db.prepare(`SELECT secret_hash FROM mail_client_integrations WHERE id = ?`).bind(parsed[1]).first<{ secret_hash: string }>();
  // Hash even when there's no row, so the response time doesn't say which.
  const presented = await sha256Hex(secret);
  if (!row || !timingSafeEqual(presented, row.secret_hash)) return null;
  const integration = await findIntegration(db, parsed[1]!);
  return integration && integration.status === "active" ? integration : null;
}

/** Opaque, integration-assigned user id: any non-empty string up to 200 chars without control characters. */
export function parseExternalUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.length || value.length > MAX_EXTERNAL_USER_ID) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** An absolute http(s) URL, or null. Its host is deliberately NOT restricted: it's the integration's own panel. */
export function parseReturnUrl(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || value.length > MAX_RETURN_URL) return { ok: false };
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false };
    if (u.username || u.password) return { ok: false };
    return { ok: true, value: u.toString() };
  } catch {
    return { ok: false };
  }
}

function parsePermissions(value: unknown): { read: boolean; send: boolean; delete: boolean; manageSettings: boolean } | null {
  if (value === undefined || value === null) return { read: true, send: false, delete: false, manageSettings: false };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  for (const k of ["read", "send", "delete", "manageSettings"]) if (p[k] !== undefined && typeof p[k] !== "boolean") return null;
  return { read: p.read !== false, send: p.send === true, delete: p.delete === true, manageSettings: p.manageSettings === true };
}

function requireJson(request: Request): Response | null {
  const type = (request.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json" ? null : errorResponse(415, "Expected a JSON request.");
}

type AdminRoute = (args: { request: Request; db: D1Database; integration: ConnectIntegration }) => Promise<Response>;

/** Wraps an admin route with bearer authentication. Errors never include request details. */
export function integrationHandler(fn: AdminRoute): PagesFunction<MailConnectEnv> {
  return async (ctx) => {
    const db = ctx.env.DB;
    if (!db) return errorResponse(500, "Not configured");
    try {
      const integration = await authenticateIntegration(db, ctx.request.headers.get("Authorization"));
      if (!integration) return errorResponse(401, NOT_AUTHENTICATED);
      if (ctx.request.method !== "GET") {
        const notJson = requireJson(ctx.request);
        if (notJson) return notJson;
      }
      return await fn({ request: ctx.request, db, integration });
    } catch (err) {
      // Deliberately no request headers or body in the log: the bearer secret lives there.
      console.error("mail-connect admin route error", ctx.request.method, new URL(ctx.request.url).pathname, err instanceof Error ? err.message : "unknown");
      return errorResponse(500, "Something went wrong processing this request.");
    }
  };
}

interface GrantRow {
  email_address: string;
  display_name: string;
  can_read: number;
  can_send: number;
  can_delete: number;
  can_manage_settings: number;
  is_default: number;
  granted_by: string | null;
  updated_at: string;
  available: number;
}

async function listGrants(db: D1Database, integrationId: string, externalUserId: string) {
  const rows = await db
    .prepare(
      `SELECT m.email_address, m.display_name, g.can_read, g.can_send, g.can_delete, g.can_manage_settings, g.is_default, g.granted_by, g.updated_at,
              CASE WHEN ${GRANTABLE_CONDITION} THEN 1 ELSE 0 END AS available
       FROM mail_external_mailbox_access g
       JOIN mail_client_integrations i ON i.id = g.integration_id
       JOIN mail_accounts m ON m.id = g.mail_account_id
       WHERE g.integration_id = ? AND g.external_user_id = ?
       ORDER BY g.is_default DESC, m.email_address`
    )
    .bind(integrationId, externalUserId)
    .all<GrantRow>();
  return rows.results.map((r) => ({
    address: r.email_address,
    displayName: r.display_name,
    permissions: { read: !!r.can_read, send: !!r.can_send, delete: !!r.can_delete, manageSettings: !!r.can_manage_settings },
    isDefault: !!r.is_default,
    // false = the grant exists but the mailbox is currently unavailable
    // (service suspended, mailbox deleted, detached by Altaventures).
    available: !!r.available,
    grantedBy: r.granted_by,
    updatedAt: r.updated_at,
  }));
}

// GET /api/mail-connect/admin/grants?externalUserId=
export const listGrantsRoute: AdminRoute = async ({ request, db, integration }) => {
  const externalUserId = parseExternalUserId(new URL(request.url).searchParams.get("externalUserId"));
  if (!externalUserId) return errorResponse(400, "externalUserId is required.");
  return jsonResponse(200, { externalUserId, grants: await listGrants(db, integration.id, externalUserId) });
};

// POST /api/mail-connect/admin/grants
// { externalUserId, address, permissions?: { read?, send?, delete?, manageSettings? }, isDefault?, grantedBy? }
// Creates or replaces this user's grant to that mailbox. isDefault: true
// also clears the user's previous default, in the same batch.
export const upsertGrantRoute: AdminRoute = async ({ request, db, integration }) => {
  const body = await readJsonBody(request);
  if (!body) return errorResponse(400, "Invalid request body");
  const externalUserId = parseExternalUserId(body.externalUserId);
  if (!externalUserId) return errorResponse(400, "externalUserId is required.");
  const address = typeof body.address === "string" ? normalizeEmail(body.address.slice(0, 320)) : "";
  if (!isValidEmail(address)) return errorResponse(400, "address must be an email address.");
  const permissions = parsePermissions(body.permissions);
  if (!permissions) return errorResponse(400, "permissions must be an object of booleans.");
  if (body.isDefault !== undefined && typeof body.isDefault !== "boolean") return errorResponse(400, "isDefault must be a boolean.");
  const grantedBy = body.grantedBy === undefined || body.grantedBy === null ? null : parseExternalUserId(body.grantedBy);
  if (body.grantedBy !== undefined && body.grantedBy !== null && !grantedBy) return errorResponse(400, "grantedBy must be a user id string.");

  const mailbox = await findGrantableMailbox(db, integration.id, address);
  if (!mailbox) return errorResponse(404, "Mailbox not found.");

  const now = new Date().toISOString();
  const isDefault = body.isDefault === true;
  const stmts: D1PreparedStatement[] = [];
  if (isDefault) {
    stmts.push(
      db
        .prepare(`UPDATE mail_external_mailbox_access SET is_default = 0, updated_at = ? WHERE integration_id = ? AND external_user_id = ? AND is_default = 1 AND mail_account_id != ?`)
        .bind(now, integration.id, externalUserId, mailbox.id)
    );
  }
  // isDefault omitted keeps an existing grant's default flag as it was.
  stmts.push(
    db
      .prepare(
        `INSERT INTO mail_external_mailbox_access (id, integration_id, external_user_id, mail_account_id, can_read, can_send, can_delete, can_manage_settings, is_default, granted_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (integration_id, external_user_id, mail_account_id) DO UPDATE SET
           can_read = excluded.can_read, can_send = excluded.can_send, can_delete = excluded.can_delete,
           can_manage_settings = excluded.can_manage_settings,
           is_default = ${body.isDefault === undefined ? "mail_external_mailbox_access.is_default" : "excluded.is_default"},
           granted_by = excluded.granted_by, updated_at = excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        integration.id,
        externalUserId,
        mailbox.id,
        permissions.read ? 1 : 0,
        permissions.send ? 1 : 0,
        permissions.delete ? 1 : 0,
        permissions.manageSettings ? 1 : 0,
        isDefault ? 1 : 0,
        grantedBy,
        now,
        now
      )
  );
  await db.batch(stmts);
  await logMailEvent(db, {
    accountId: mailbox.id,
    messageId: null,
    type: "connect_grant_upserted",
    data: { integrationId: integration.id, externalUserId, permissions, isDefault: body.isDefault ?? null, grantedBy },
    actorId: connectActorId(integration.id, grantedBy ?? externalUserId),
  });
  return jsonResponse(200, { externalUserId, grants: await listGrants(db, integration.id, externalUserId) });
};

// DELETE /api/mail-connect/admin/grants  { externalUserId, address, revokedBy? }
// Revokes one grant. Works even when the mailbox has since left the
// grantable set (a grant you can't use should still be removable). Scoped
// to this integration's own rows, so it can never touch another's.
export const revokeGrantRoute: AdminRoute = async ({ request, db, integration }) => {
  const body = await readJsonBody(request);
  if (!body) return errorResponse(400, "Invalid request body");
  const externalUserId = parseExternalUserId(body.externalUserId);
  if (!externalUserId) return errorResponse(400, "externalUserId is required.");
  const address = typeof body.address === "string" ? normalizeEmail(body.address.slice(0, 320)) : "";
  if (!isValidEmail(address)) return errorResponse(400, "address must be an email address.");
  const revokedBy = parseExternalUserId(body.revokedBy);
  const account = await db.prepare(`SELECT id FROM mail_accounts WHERE email_address = ?`).bind(address).first<{ id: string }>();
  let revoked = false;
  if (account) {
    const r = await db
      .prepare(`DELETE FROM mail_external_mailbox_access WHERE integration_id = ? AND external_user_id = ? AND mail_account_id = ?`)
      .bind(integration.id, externalUserId, account.id)
      .run();
    revoked = (r.meta.changes ?? 0) > 0;
    if (revoked) {
      await logMailEvent(db, {
        accountId: account.id,
        messageId: null,
        type: "connect_grant_revoked",
        data: { integrationId: integration.id, externalUserId, revokedBy },
        actorId: connectActorId(integration.id, revokedBy ?? externalUserId),
      });
    }
  }
  return jsonResponse(200, { externalUserId, revoked, grants: await listGrants(db, integration.id, externalUserId) });
};

// POST /api/mail-connect/admin/launch  { externalUserId, returnUrl? }
// -> 201 { launchUrl, expiresAt }. Issued even when the user currently has
// no grants: webmail itself then shows "no mailbox assigned" (or "service
// unavailable"), so no integrating app has to build that copy. The launch
// URL is on the same origin this request was made to, which is where the
// session cookie must be set and /mail/connect is served.
export const launchRoute: AdminRoute = async ({ request, db, integration }) => {
  const body = await readJsonBody(request);
  if (!body) return errorResponse(400, "Invalid request body");
  const externalUserId = parseExternalUserId(body.externalUserId);
  if (!externalUserId) return errorResponse(400, "externalUserId is required.");
  const returnUrl = parseReturnUrl(body.returnUrl);
  if (!returnUrl.ok) return errorResponse(400, "returnUrl must be an absolute http(s) URL.");

  const id = crypto.randomUUID();
  const code = `${id}.${randomHex(32)}`;
  const now = Date.now();
  const expiresAt = new Date(now + LAUNCH_CODE_TTL_MS).toISOString();
  await db
    .prepare(`INSERT INTO mail_launch_codes (id, integration_id, external_user_id, return_url, code, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(id, integration.id, externalUserId, returnUrl.value, code, expiresAt, new Date(now).toISOString())
    .run();
  const launchUrl = `${new URL(request.url).origin}/api/mail-connect/exchange?code=${encodeURIComponent(code)}`;
  return jsonResponse(201, { launchUrl, expiresAt });
};
