// GET  /api/app/mail/drafts?accountId=<id|all> -- the caller's own drafts (drafts are private to their author)
// POST /api/app/mail/drafts -- { accountId, mode: new|reply|reply_all|forward, sourceMessageId? }
//   Creates a draft pre-filled server-side: recipients (Reply/Reply-All
//   rules), Re:/Fwd: subject, quoted original, the identity's signature,
//   and -- for a forward -- the original's attachments.

import { placeholders, scopeAccountIds, buildPrefill, loadSignatures, signatureBlock, asString, errorResponse, jsonResponse, nowIso, readJsonBody, loadDraft, serializeDraftSummary, type DraftRow } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";

export const onRequestGet = mailHandler(async ({ ctx, db, user, access }) => {
  const ids = scopeAccountIds(access, new URL(ctx.request.url).searchParams.get("accountId"));
  if (!ids.length) return jsonResponse(200, { drafts: [] });
  const rows = await db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM mail_attachments a WHERE a.draft_id = d.id) AS attachment_count
       FROM mail_drafts d WHERE d.account_id IN (${placeholders(ids.length)}) AND d.created_by = ? ORDER BY d.updated_at DESC LIMIT 200`
    )
    .bind(...ids, user.id)
    .all<DraftRow & { attachment_count: number }>();
  return jsonResponse(200, { drafts: rows.results.map(serializeDraftSummary) });
});

export const onRequestPost = mailHandler(async ({ ctx, db, user, access }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const accountId = asString(body.accountId, 100);
  const entry = access.get(accountId);
  if (!entry) return errorResponse(404, "Mailbox not found.");
  if (!entry.canSend) return errorResponse(403, "You have read-only access to this mailbox.");
  const mode = body.mode === "reply" || body.mode === "reply_all" || body.mode === "forward" ? body.mode : "new";
  const sourceMessageId = typeof body.sourceMessageId === "string" ? body.sourceMessageId : null;
  const id = crypto.randomUUID();
  const now = nowIso();

  let to: unknown[] = [];
  let cc: unknown[] = [];
  let subject = "";
  let bodyHtml = "";
  let threadId: string | null = null;
  if (mode !== "new") {
    if (!sourceMessageId) return errorResponse(400, "sourceMessageId is required for replies and forwards.");
    const prefill = await buildPrefill(db, access, accountId, mode, sourceMessageId);
    if (!prefill) return errorResponse(404, "Original message not found.");
    to = prefill.to;
    cc = prefill.cc;
    subject = prefill.subject;
    bodyHtml = prefill.bodyHtml;
    threadId = prefill.threadId;
  } else {
    const sig = (await loadSignatures(db, [accountId])).find((s) => s.use_for_new);
    bodyHtml = sig ? `<p><br></p>${signatureBlock(sig.body_html)}` : "";
  }

  const stmts = [
    db
      .prepare(
        `INSERT INTO mail_drafts (id, account_id, thread_id, compose_mode, source_message_id, to_json, cc_json, bcc_json, subject, body_html, body_text, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, '', 1, ?, ?, ?)`
      )
      .bind(id, accountId, threadId, mode, mode === "new" ? null : sourceMessageId, JSON.stringify(to), JSON.stringify(cc), subject, bodyHtml, user.id, now, now),
  ];
  if (mode === "forward" && sourceMessageId) {
    // Forwarded attachments reference the same private R2 object (no copy);
    // storage.ts only deletes an object once nothing references it.
    const atts = await db
      .prepare(`SELECT id, filename, mime_type, size_bytes, storage_key, content_id, is_inline FROM mail_attachments WHERE message_id = ? AND storage_status = 'stored'`)
      .bind(sourceMessageId)
      .all<{ id: string; filename: string; mime_type: string; size_bytes: number; storage_key: string; content_id: string | null; is_inline: number }>();
    for (const a of atts.results) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO mail_attachments (id, account_id, message_id, draft_id, filename, mime_type, size_bytes, storage_key, content_id, is_inline, storage_status, uploaded_by, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?)`
          )
          .bind(crypto.randomUUID(), accountId, id, a.filename, a.mime_type, a.size_bytes, a.storage_key, a.content_id, a.is_inline, user.id, now)
      );
    }
  }
  await db.batch(stmts);
  const draft = await loadDraft(db, access, user.id, id);
  return jsonResponse(201, draft);
});
