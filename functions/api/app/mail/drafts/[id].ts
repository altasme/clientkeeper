// GET    /api/app/mail/drafts/:id
// PATCH  /api/app/mail/drafts/:id -- autosave: { version, accountId?, to?, cc?, bcc?, subject?, bodyHtml? }
//        A stale `version` returns 409 with the server's current version, so a
//        second tab can never silently overwrite newer content.
// DELETE /api/app/mail/drafts/:id -- discard (attachments too)

import { errorResponse, jsonResponse, normalizeParam, nowIso, readJsonBody } from "../../../../_lib/mail/http";
import { mailHandler } from "../../../../_lib/mail/route";
import { coerceDraftAddresses, loadDraft } from "../../../../_lib/mail/drafts";
import { deleteUnreferencedObjects } from "../../../../_lib/mail/storage";
import { htmlToText } from "../../../../_lib/mail/text";

const MAX_DRAFT_HTML = 2 * 1024 * 1024;

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const draft = await loadDraft(db, access, user.id, normalizeParam(ctx.params.id));
  if (!draft) return errorResponse(404, "Draft not found.");
  return jsonResponse(200, draft);
});

export const onRequestPatch = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const current = await loadDraft(db, access, user.id, id);
  if (!current) return errorResponse(404, "Draft not found.");
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  if (typeof body.version !== "number") return errorResponse(400, "version is required.");
  if (body.version !== current.version) return errorResponse(409, "This draft was changed elsewhere.", { currentVersion: current.version, draft: current });

  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (typeof body.accountId === "string" && body.accountId !== current.accountId) {
    const entry = access.get(body.accountId);
    if (!entry?.canSend) return errorResponse(403, "You can't send from that identity.");
    sets.push("account_id = ?", "thread_id = NULL");
    vals.push(body.accountId);
  }
  for (const [key, col] of [
    ["to", "to_json"],
    ["cc", "cc_json"],
    ["bcc", "bcc_json"],
  ] as const) {
    if (body[key] !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(JSON.stringify(coerceDraftAddresses(body[key])));
    }
  }
  if (typeof body.subject === "string") {
    sets.push("subject = ?");
    vals.push(body.subject.replace(/[\r\n]+/g, " ").slice(0, 900));
  }
  if (typeof body.bodyHtml === "string") {
    if (new TextEncoder().encode(body.bodyHtml).length > MAX_DRAFT_HTML) return errorResponse(413, "Draft body is too large.");
    sets.push("body_html = ?", "body_text = ?");
    vals.push(body.bodyHtml, htmlToText(body.bodyHtml).slice(0, 100_000));
  }
  if (!sets.length) return jsonResponse(200, current);
  const r = await db
    .prepare(`UPDATE mail_drafts SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND created_by = ?`)
    .bind(...vals, nowIso(), id, current.version, user.id)
    .run();
  if (!r.meta.changes) {
    const fresh = await loadDraft(db, access, user.id, id);
    return errorResponse(409, "This draft was changed elsewhere.", { currentVersion: fresh?.version, draft: fresh });
  }
  if (typeof body.accountId === "string" && body.accountId !== current.accountId) {
    await db.prepare(`UPDATE mail_attachments SET account_id = ? WHERE draft_id = ?`).bind(body.accountId, id).run();
  }
  return jsonResponse(200, await loadDraft(db, access, user.id, id));
});

export const onRequestDelete = mailHandler<"id">(async ({ ctx, db, user, access }) => {
  const id = normalizeParam(ctx.params.id);
  const current = await loadDraft(db, access, user.id, id);
  if (!current) return errorResponse(404, "Draft not found.");
  const keys = await db.prepare(`SELECT storage_key FROM mail_attachments WHERE draft_id = ?`).bind(id).all<{ storage_key: string }>();
  await db.batch([db.prepare(`DELETE FROM mail_attachments WHERE draft_id = ?`).bind(id), db.prepare(`DELETE FROM mail_drafts WHERE id = ?`).bind(id)]);
  await deleteUnreferencedObjects(db, ctx.env.MAIL_ATTACHMENTS, keys.results.map((k) => k.storage_key));
  return jsonResponse(200, { ok: true });
});
