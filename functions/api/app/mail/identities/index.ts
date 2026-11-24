// GET  /api/app/mail/identities        -> the mailboxes the caller can access (+ signatures, status)
//      ?all=1 (owner/admin)             -> every configured identity, for the settings screen
// POST /api/app/mail/identities        -> create an identity (owner/admin)
//
// No credential is ever returned: SMTP status is a configured/not_configured
// flag computed server-side from env (config.ts smtpStatus()).

import { isValidEmail, normalizeEmail, isMailAdmin, loadSignatures, serializeSignature, smtpStatus, logMailEvent, asString, errorResponse, jsonResponse, nowIso, readJsonBody } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";

interface AccountRow {
  id: string;
  email_address: string;
  display_name: string;
  reply_to: string | null;
  smtp_profile: string | null;
  inbound_enabled: number;
  outbound_enabled: number;
  is_active: number;
  sort_order: number;
  created_at: string;
}

export const onRequestGet = mailHandler(async ({ ctx, db, user, access }) => {
  const all = new URL(ctx.request.url).searchParams.get("all") === "1" && isMailAdmin(user);
  const rows = await db
    .prepare(
      `SELECT id, email_address, display_name, reply_to, smtp_profile, inbound_enabled, outbound_enabled, is_active, sort_order, created_at
       FROM mail_accounts ORDER BY sort_order, email_address`
    )
    .all<AccountRow>();
  const visible = rows.results.filter((r) => all || access.has(r.id));
  const ids = visible.map((r) => r.id);
  const signatures = await loadSignatures(db, ids);
  const lastInbound = ids.length
    ? await db
        .prepare(`SELECT account_id, MAX(received_at) AS last FROM mail_messages WHERE direction = 'inbound' AND account_id IN (${ids.map(() => "?").join(", ")}) GROUP BY account_id`)
        .bind(...ids)
        .all<{ account_id: string; last: string }>()
    : { results: [] as { account_id: string; last: string }[] };
  const lastMap = new Map(lastInbound.results.map((r) => [r.account_id, r.last]));
  const accessCounts = all
    ? await db.prepare(`SELECT account_id, COUNT(*) AS n FROM mail_account_access GROUP BY account_id`).all<{ account_id: string; n: number }>()
    : { results: [] as { account_id: string; n: number }[] };
  const countMap = new Map(accessCounts.results.map((r) => [r.account_id, r.n]));

  return jsonResponse(200, {
    isAdmin: isMailAdmin(user),
    identities: visible.map((r) => ({
      id: r.id,
      emailAddress: r.email_address,
      displayName: r.display_name,
      replyTo: r.reply_to,
      smtpProfile: all ? r.smtp_profile : undefined,
      inboundEnabled: !!r.inbound_enabled,
      outboundEnabled: !!r.outbound_enabled,
      isActive: !!r.is_active,
      sortOrder: r.sort_order,
      canAccess: access.has(r.id),
      canSend: access.get(r.id)?.canSend ?? false,
      smtpStatus: smtpStatus(ctx.env, r.smtp_profile),
      lastInboundAt: lastMap.get(r.id) ?? null,
      accessCount: all ? countMap.get(r.id) ?? 0 : undefined,
      signatures: signatures.filter((s) => s.account_id === r.id).map(serializeSignature),
    })),
  });
});

const PROFILE_RE = /^[A-Za-z0-9_-]{1,50}$/;

export function validateIdentityFields(b: Record<string, unknown>, partial: boolean): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } {
  const fields: Record<string, unknown> = {};
  if (b.emailAddress !== undefined || !partial) {
    const email = asString(b.emailAddress, 320).trim();
    if (!isValidEmail(email)) return { ok: false, error: "A valid email address is required." };
    fields.email_address = normalizeEmail(email);
  }
  if (b.displayName !== undefined || !partial) {
    const name = asString(b.displayName, 200).replace(/[\r\n]+/g, " ").trim();
    if (!name) return { ok: false, error: "Display name is required." };
    fields.display_name = name;
  }
  if (b.replyTo !== undefined) {
    const rt = asString(b.replyTo, 320).trim();
    if (rt && !isValidEmail(rt)) return { ok: false, error: "Reply-To must be a valid email address." };
    fields.reply_to = rt ? normalizeEmail(rt) : null;
  }
  if (b.smtpProfile !== undefined) {
    const p = asString(b.smtpProfile, 50).trim();
    if (p && !PROFILE_RE.test(p)) return { ok: false, error: "SMTP profile name may only contain letters, numbers, - and _." };
    fields.smtp_profile = p || null;
  }
  for (const [key, col] of [
    ["inboundEnabled", "inbound_enabled"],
    ["outboundEnabled", "outbound_enabled"],
    ["isActive", "is_active"],
  ] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== "boolean") return { ok: false, error: `${key} must be true or false.` };
      fields[col] = b[key] ? 1 : 0;
    }
  }
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return { ok: false, error: "sortOrder must be 0-1000." };
    fields.sort_order = n;
  }
  return { ok: true, fields };
}

export const onRequestPost = mailHandler(async ({ ctx, db, user }) => {
  if (!isMailAdmin(user)) return errorResponse(403, "Only an owner or admin can add mailboxes.");
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const v = validateIdentityFields(body, false);
  if (!v.ok) return errorResponse(400, v.error);
  const existing = await db.prepare(`SELECT id FROM mail_accounts WHERE email_address = ?`).bind(v.fields.email_address).first();
  if (existing) return errorResponse(409, "That address is already configured.");
  const id = crypto.randomUUID();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO mail_accounts (id, email_address, display_name, reply_to, smtp_profile, inbound_enabled, outbound_enabled, is_active, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    )
    .bind(
      id,
      v.fields.email_address,
      v.fields.display_name,
      (v.fields.reply_to as string | null) ?? null,
      (v.fields.smtp_profile as string | null) ?? null,
      (v.fields.inbound_enabled as number | undefined) ?? 1,
      (v.fields.outbound_enabled as number | undefined) ?? 1,
      (v.fields.sort_order as number | undefined) ?? 0,
      user.id,
      now,
      now
    )
    .run();
  await logMailEvent(db, { accountId: id, type: "identity_created", data: { email: v.fields.email_address }, actorId: user.id });
  return jsonResponse(201, { id });
});
