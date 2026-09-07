// Cloudflare Pages Function: POST /api/app/clients/:id/resend-invite
//
// CLAUDE.md §2's "Paid, no account yet list + Resend invite action" — the
// mutating half of it (functions/api/app/clients/index.ts's
// paidNoAccount=1 filter is the read half). Re-sends the account-setup
// reminder email for a client whose invitation_status isn't 'accepted'
// yet. Audited: this can be re-triggered as often as staff want (an email
// can get lost, land in spam, or simply go unread), so every call is
// logged, not just the first.
//
// [2026-09-07 fix] This used to call WorkOS's sendInvitation(), which
// emails WorkOS's own accept_invitation_url — a second, WorkOS-controlled
// way into account creation, alongside the marketing site's thank-you
// page button. A real client hit both at once and got confused about
// which was the actual way in. clienthub's ganap webhook no longer sends
// that invitation automatically at all; this button now re-sends the
// same plain reminder email (functions/_lib/email.ts) pointing at the one
// real entry point instead of asking WorkOS to create a second one.
//
// Required env vars: RESEND_API_KEY, RESEND_FROM_EMAIL.

import { sendEmail, accountReminderEmail } from "../../../../_lib/email";
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
    .prepare(`SELECT id, email, full_name, business_name, invitation_status FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; email: string; full_name: string; business_name: string; invitation_status: string }>();

  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.invitation_status === "accepted") {
    return jsonResponse(400, { error: "This client already has an account." });
  }

  try {
    const { subject, html } = accountReminderEmail({ clientName: client.full_name, businessName: client.business_name });
    await sendEmail({ RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL }, { to: client.email, subject, html });
  } catch (err) {
    console.error("resend-invite: failed to send account reminder email", err);
    return jsonResponse(502, { error: "Failed to send the reminder email. Please try again shortly." });
  }

  const now = new Date().toISOString();

  await db.prepare(`UPDATE clients SET updated_at = ? WHERE id = ?`).bind(now, clientId).run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'resend_account_reminder', 'client', ?, ?, ?, NULL, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      clientId,
      JSON.stringify({ invitation_status: client.invitation_status }),
      JSON.stringify({ invitation_status: client.invitation_status }),
      now
    )
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'invitation', 'Account setup reminder email re-sent', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { ok: true });
};
