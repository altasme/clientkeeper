// PATCH /api/app/mail/identities/:id -- edit an identity (owner/admin).
// Deactivating (isActive:false) hides it from everyone's mailbox list and
// From picker without deleting any mail.

import { isMailAdmin, logMailEvent, errorResponse, jsonResponse, normalizeParam, nowIso, readJsonBody } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";
import { validateIdentityFields } from "./index";

export const onRequestPatch = mailHandler<"id">(async ({ ctx, db, user }) => {
  if (!isMailAdmin(user)) return errorResponse(403, "Only an owner or admin can edit mailboxes.");
  const id = normalizeParam(ctx.params.id);
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const existing = await db.prepare(`SELECT id, email_address FROM mail_accounts WHERE id = ?`).bind(id).first<{ id: string; email_address: string }>();
  if (!existing) return errorResponse(404, "Mailbox not found.");
  const v = validateIdentityFields(body, true);
  if (!v.ok) return errorResponse(400, v.error);
  const cols = Object.keys(v.fields);
  if (!cols.length) return errorResponse(400, "Nothing to update.");
  if (v.fields.email_address && v.fields.email_address !== existing.email_address) {
    const dupe = await db.prepare(`SELECT id FROM mail_accounts WHERE email_address = ? AND id != ?`).bind(v.fields.email_address, id).first();
    if (dupe) return errorResponse(409, "That address is already configured.");
  }
  await db
    .prepare(`UPDATE mail_accounts SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...cols.map((c) => v.fields[c] as string | number | null), nowIso(), id)
    .run();
  await logMailEvent(db, { accountId: id, type: "identity_updated", data: v.fields, actorId: user.id });
  return jsonResponse(200, { ok: true });
});
