// GET /api/app/mail/identities/:id/access -- who can read/send from this mailbox (owner/admin)
// PUT /api/app/mail/identities/:id/access -- replace the grant list: { grants: [{ userId, canSend }] }
// Access is explicit and defaults to nobody (CLAUDE.md §32).

import { isMailAdmin, logMailEvent, errorResponse, jsonResponse, normalizeParam, nowIso, readJsonBody } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../../_lib/mailHandler";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, user }) => {
  if (!isMailAdmin(user)) return errorResponse(403, "Only an owner or admin can manage mailbox access.");
  const id = normalizeParam(ctx.params.id);
  const account = await db.prepare(`SELECT id FROM mail_accounts WHERE id = ?`).bind(id).first();
  if (!account) return errorResponse(404, "Mailbox not found.");
  const rows = await db
    .prepare(`SELECT a.user_id, a.can_send, u.email, u.full_name, u.role FROM mail_account_access a JOIN users u ON u.id = a.user_id WHERE a.account_id = ? ORDER BY u.email`)
    .bind(id)
    .all<{ user_id: string; can_send: number; email: string; full_name: string | null; role: string }>();
  return jsonResponse(200, {
    grants: rows.results.map((r) => ({ userId: r.user_id, canSend: !!r.can_send, email: r.email, fullName: r.full_name, role: r.role })),
  });
});

export const onRequestPut = mailHandler<"id">(async ({ ctx, db, user }) => {
  if (!isMailAdmin(user)) return errorResponse(403, "Only an owner or admin can manage mailbox access.");
  const id = normalizeParam(ctx.params.id);
  const account = await db.prepare(`SELECT id FROM mail_accounts WHERE id = ?`).bind(id).first();
  if (!account) return errorResponse(404, "Mailbox not found.");
  const body = await readJsonBody(ctx.request);
  if (!body || !Array.isArray(body.grants)) return errorResponse(400, "grants must be an array.");
  const grants = new Map<string, boolean>();
  for (const g of body.grants.slice(0, 200)) {
    if (!g || typeof g !== "object") return errorResponse(400, "Invalid grant.");
    const o = g as Record<string, unknown>;
    if (typeof o.userId !== "string" || !o.userId) return errorResponse(400, "Invalid grant.");
    grants.set(o.userId, o.canSend !== false);
  }
  if (grants.size) {
    const ids = [...grants.keys()];
    const found = await db.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<{ id: string }>();
    if (found.results.length !== ids.length) return errorResponse(400, "One or more staff members don't exist.");
  }
  const now = nowIso();
  await db.batch([
    db.prepare(`DELETE FROM mail_account_access WHERE account_id = ?`).bind(id),
    ...[...grants].map(([userId, canSend]) =>
      db.prepare(`INSERT INTO mail_account_access (account_id, user_id, can_send, granted_by, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, userId, canSend ? 1 : 0, user.id, now)
    ),
  ]);
  await logMailEvent(db, { accountId: id, type: "access_updated", data: { grants: [...grants].map(([u, s]) => ({ u, s })) }, actorId: user.id });
  return jsonResponse(200, { ok: true });
});
