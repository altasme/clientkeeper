// Cloudflare Pages Function: POST /api/app/clients/:id/send-domain-reminder
//
// CLAUDE.md §19/§20's "Send Domain Renewal Reminder" action. Manual,
// staff-triggered on demand (not a scheduled job) — same as every other
// email button in this app, and the simplest option since there's no
// existing cron infrastructure here to hang an automatic near-expiration
// check off of. Staff click this whenever they judge it's time.
//
// Requires `clients.domain_registered_at` to be set (via set-dates.ts) —
// there's nothing to remind anyone about otherwise. Expiration itself is
// never stored; `domainRenewalReminderEmail()` computes it as
// registration + 1 year at send time (functions/_lib/email.ts).
//
// Same structure as send-wsa.ts: looks up the client, sends via Resend,
// logs audit_log + client_activity only on a successful send.

import { sendEmail, domainRenewalReminderEmail } from "../../../../_lib/email";
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
    .prepare(`SELECT id, email, full_name, business_name, domain_registered_at FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; email: string; full_name: string; business_name: string; domain_registered_at: string | null }>();

  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (!client.domain_registered_at) {
    return jsonResponse(400, { error: "No domain registration date on record for this client." });
  }

  try {
    const { subject, html } = domainRenewalReminderEmail({
      clientName: client.full_name,
      businessName: client.business_name,
      domainRegisteredAt: client.domain_registered_at,
    });
    await sendEmail({ RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL }, { to: client.email, subject, html });
  } catch (err) {
    console.error("send-domain-reminder: failed to send reminder email", err);
    return jsonResponse(502, { error: "Failed to send the reminder email. Please try again shortly." });
  }

  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'domain_reminder_sent', 'client', ?, NULL, ?, NULL, ?)`
    )
    .bind(crypto.randomUUID(), data.staffUser.id, clientId, JSON.stringify({ email: client.email, domainRegisteredAt: client.domain_registered_at }), now)
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'domain_reminder_sent', 'Domain renewal reminder emailed to client', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { ok: true });
};
