// Cloudflare Pages Function: POST /api/app/clients/:id/set-details
//
// Lets staff edit a client's core identity fields directly from the
// Client Detail page (full name, business name, email, mobile, Facebook,
// existing website) — previously plain read-only text with no way to
// correct a typo or update a changed number/email after the record was
// created. Same optional-field, "only update what's sent" convention as
// set-dates.ts: every field is independently optional, so a partial edit
// (just the mobile number, say) doesn't require resending everything.
//
// Email gets the same format check and case-insensitive duplicate check
// already used by the manual-add-client endpoint (clients/index.ts),
// excluding this client's own row, so editing a client's email can never
// silently collide with another client record.

import type { StaffUser } from "../../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 200;

// undefined: field not sent, leave unchanged. null: send "" to clear an
// optional field. Required fields (fullName/businessName/email) reject an
// empty value instead of accepting null, since this table's columns are
// NOT NULL.
function normalizeOptional(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const onRequestPost: PagesFunction<Env, "id", { staffUser: StaffUser }> = async ({ request, env, params, data }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = params.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const client = await db
    .prepare(`SELECT id, full_name, business_name, email, mobile, facebook, current_website FROM clients WHERE id = ?`)
    .bind(clientId)
    .first<{
      id: string;
      full_name: string;
      business_name: string;
      email: string;
      mobile: string | null;
      facebook: string | null;
      current_website: string | null;
    }>();
  if (!client) return jsonResponse(404, { error: "Client not found" });

  const fullNameRaw = typeof b.fullName === "string" ? b.fullName.trim() : undefined;
  const businessNameRaw = typeof b.businessName === "string" ? b.businessName.trim() : undefined;
  const emailRaw = typeof b.email === "string" ? b.email.trim() : undefined;
  const mobile = normalizeOptional(b.mobile);
  const facebook = normalizeOptional(b.facebook);
  const currentWebsite = normalizeOptional(b.currentWebsite);

  if (
    fullNameRaw === undefined &&
    businessNameRaw === undefined &&
    emailRaw === undefined &&
    mobile === undefined &&
    facebook === undefined &&
    currentWebsite === undefined
  ) {
    return jsonResponse(400, { error: "Nothing to update." });
  }

  if (fullNameRaw !== undefined && !fullNameRaw) return jsonResponse(400, { error: "Client name is required." });
  if (businessNameRaw !== undefined && !businessNameRaw) return jsonResponse(400, { error: "Business name is required." });
  if (emailRaw !== undefined && (!emailRaw || !EMAIL_RE.test(emailRaw))) return jsonResponse(400, { error: "A valid email is required." });
  for (const [label, value] of [
    ["Client name", fullNameRaw],
    ["Business name", businessNameRaw],
    ["Email", emailRaw],
    ["Mobile", mobile],
    ["Facebook", facebook],
    ["Existing website", currentWebsite],
  ] as const) {
    if (typeof value === "string" && value.length > MAX_FIELD_LENGTH) {
      return jsonResponse(400, { error: `${label} is too long.` });
    }
  }

  if (emailRaw !== undefined && emailRaw.toLowerCase() !== client.email.toLowerCase()) {
    const existing = await db
      .prepare(`SELECT id FROM clients WHERE LOWER(email) = LOWER(?) AND id != ?`)
      .bind(emailRaw, clientId)
      .first<{ id: string }>();
    if (existing) return jsonResponse(409, { error: "Another client already uses this email." });
  }

  const next = {
    full_name: fullNameRaw !== undefined ? fullNameRaw : client.full_name,
    business_name: businessNameRaw !== undefined ? businessNameRaw : client.business_name,
    email: emailRaw !== undefined ? emailRaw : client.email,
    mobile: mobile !== undefined ? mobile : client.mobile,
    facebook: facebook !== undefined ? facebook : client.facebook,
    current_website: currentWebsite !== undefined ? currentWebsite : client.current_website,
  };
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE clients SET full_name = ?, business_name = ?, email = ?, mobile = ?, facebook = ?, current_website = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(next.full_name, next.business_name, next.email, next.mobile, next.facebook, next.current_website, now, clientId)
    .run();

  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, 'set_client_details', 'client', ?, ?, ?, NULL, ?)`
    )
    .bind(
      crypto.randomUUID(),
      data.staffUser.id,
      clientId,
      JSON.stringify({
        fullName: client.full_name,
        businessName: client.business_name,
        email: client.email,
        mobile: client.mobile,
        facebook: client.facebook,
        currentWebsite: client.current_website,
      }),
      JSON.stringify({
        fullName: next.full_name,
        businessName: next.business_name,
        email: next.email,
        mobile: next.mobile,
        facebook: next.facebook,
        currentWebsite: next.current_website,
      }),
      now
    )
    .run();

  await db
    .prepare(
      `INSERT INTO client_activity (id, client_id, type, description, actor_id, created_at)
       VALUES (?, ?, 'set_client_details', 'Client details updated by staff', ?, ?)`
    )
    .bind(crypto.randomUUID(), clientId, data.staffUser.id, now)
    .run();

  return jsonResponse(200, {
    ok: true,
    fullName: next.full_name,
    businessName: next.business_name,
    email: next.email,
    mobile: next.mobile,
    facebook: next.facebook,
    currentWebsite: next.current_website,
  });
};
