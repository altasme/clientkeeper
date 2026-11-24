// POST /api/app/mail/drafts/:id/send -- { idempotencyKey } send the draft as saved.
// The draft row is deleted and its attachments handed to the new message in
// the same D1 transaction that records the message + send job.

import { errorResponse, normalizeParam, readJsonBody } from "../../../../../_lib/mail/http";
import { mailHandler } from "../../../../../_lib/mail/route";
import { loadDraft } from "../../../../../_lib/mail/drafts";
import { handleSend, jobStatusResponse } from "../../../../../_lib/mail/sendRoute";

export const onRequestPost = mailHandler<"id">(async (args) => {
  const { ctx, db, user, access } = args;
  const id = normalizeParam(ctx.params.id);
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const draft = await loadDraft(db, access, user.id, id);
  if (!draft) {
    // A retried request after a successful send finds the draft gone: let
    // handleSend resolve the idempotency key to the job it already created.
    if (typeof body.idempotencyKey === "string") {
      const job = await db
        .prepare(`SELECT j.id, j.message_id, m.thread_id FROM mail_send_jobs j JOIN mail_messages m ON m.id = j.message_id WHERE j.idempotency_key = ? AND j.created_by = ?`)
        .bind(body.idempotencyKey, user.id)
        .first<{ id: string; message_id: string; thread_id: string }>();
      if (job) return jobStatusResponse(db, { jobId: job.id, messageId: job.message_id, threadId: job.thread_id, duplicate: true });
    }
    return errorResponse(404, "Draft not found.");
  }
  return handleSend(args, draft.composeMode, {
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.bodyHtml,
    sourceMessageId: draft.sourceMessageId,
    draftId: draft.id,
    idempotencyKey: body.idempotencyKey,
  });
});
