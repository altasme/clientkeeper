// Cloudflare Pages Function: POST /api/app/clients/:id/send-wsa
//
// CLAUDE.md §19's "Send WSA" action: emails the client the link to the
// marketing site's standalone Free Website Service Agreement e-signature
// page (altaventureswebsite's CLAUDE.md §17, /WSA-free — unlinked from
// that site's own nav, reached only by direct URL). Staff previously had
// to hand this link to a client manually (chat, verbally); this sends it
// straight to the email already on file for the client record, the same
// email lookup pattern as resend-invite.ts.
//
// Re-sendable as often as staff want — same reasoning as resend-invite.ts:
// a link can get lost or land in spam, and there's no "already sent" state
// worth gating on (unlike account invitations, an agreement isn't accepted
// or expired from this app's point of view; clienthub has no record of
// WSA signing at all, since that flow lives entirely on the marketing
// site's own /api/submit-wsa).
//
// Required env vars: RESEND_API_KEY, RESEND_FROM_EMAIL.

import { sendEmail, wsaAgreementEmail } from "../../../../_lib/email";
import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB || !env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  const client = await db
    .prepare(`SELECT id, email, full_name, business_name FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; email: string; full_name: string; business_name: string }>();

  if (!client) return jsonResponse(404, { error: "Client not found" });

  try {
    const { subject, html } = wsaAgreementEmail({ clientName: client.full_name, businessName: client.business_name });
    await sendEmail({ RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL }, { to: client.email, subject, html });
  } catch (err) {
    console.error("send-wsa: failed to send agreement email", err);
    return jsonResponse(502, { error: "Failed to send the agreement email. Please try again shortly." });
  }

  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'wsa_link_sent', 'client', ?, NULL, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify({ email: client.email }), now)
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'wsa_link_sent', 'Website Service Agreement link emailed to client', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { ok: true });
};
