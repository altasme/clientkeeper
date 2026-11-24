// GET /api/app/mail/staff -- staff list for the mailbox-access picker (owner/admin only).

import { isMailAdmin, errorResponse, jsonResponse } from "@altasme/webmail-kit";
import { mailHandler } from "../../../_lib/mailHandler";

export const onRequestGet = mailHandler(async ({ db, user }) => {
  if (!isMailAdmin(user)) return errorResponse(403, "Only an owner or admin can manage mailbox access.");
  const rows = await db.prepare(`SELECT id, email, full_name, role FROM users ORDER BY email`).all<{ id: string; email: string; full_name: string | null; role: string }>();
  return jsonResponse(200, { staff: rows.results.map((r) => ({ id: r.id, email: r.email, fullName: r.full_name, role: r.role })) });
});
