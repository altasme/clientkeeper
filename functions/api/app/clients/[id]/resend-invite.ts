// Cloudflare Pages Function: POST /api/app/clients/:id/resend-invite
//
// CLAUDE.md §2's "Paid, no account yet list + Resend invite action" — the
// mutating half of it (functions/api/app/clients/index.ts's
// paidNoAccount=1 filter is the read half). Re-sends the WorkOS invitation
// for a client whose invitation_status isn't 'accepted' yet, using the
// same sendInvitation() call clienthub's ganap webhook makes on first
// issuance. Audited: this can be re-triggered as often as staff want (a
// client's invitation email can get lost, land in spam, or simply expire),
// so every call is logged, not just the first.
//
// Required env vars: WORKOS_API_KEY.

import { sendInvitation } from "../../../../_lib/workos";
import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  WORKOS_API_KEY: string;
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ env, params, data }) => {
  if (!env.DB || !env.WORKOS_API_KEY) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  const client = await db
    .prepare(`SELECT id, email, invitation_status FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{ id: string; email: string; invitation_status: string }>();

  if (!client) return jsonResponse(404, { error: "Client not found" });
  if (client.invitation_status === "accepted") {
    return jsonResponse(400, { error: "This client's invitation is already accepted." });
  }

  let invitation;
  try {
    invitation = await sendInvitation(env.WORKOS_API_KEY, client.email);
  } catch (err) {
    console.error("resend-invite: WorkOS sendInvitation failed", err);
    return jsonResponse(502, { error: "Failed to send invitation. Please try again shortly." });
  }

  const now = new Date().toISOString();

  await db
    .prepare(`UPDATE clients SET workos_invitation_id = ?, invitation_status = 'pending', updated_at = ? WHERE id = ?`)
    .bind(invitation.id, now, clientId)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'resend_invite', 'client', ?, ?, ?, NULL, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      clientId,
      JSON.stringify({ invitation_status: client.invitation_status }),
      JSON.stringify({ invitation_status: "pending", workos_invitation_id: invitation.id }),
      now
    )
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'invitation', 'Account invitation re-sent', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, { ok: true });
};
