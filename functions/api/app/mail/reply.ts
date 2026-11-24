// POST /api/app/mail/reply -- send a reply (sourceMessageId required; threading headers come from the original).
// Body: { accountId, to, cc, bcc, subject, html, idempotencyKey, sourceMessageId?, draftId? }
// Response: { jobId, messageId, threadId, status: sent|retry_scheduled|failed|queued, error }
// "sent" means the SMTP server accepted the message, not that it was delivered.

import { errorResponse, readJsonBody, handleSend } from "@altasme/webmail-kit";
import { mailHandler } from "../../../_lib/mailHandler";

export const onRequestPost = mailHandler(async (args) => {
  const body = await readJsonBody(args.ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  return handleSend(args, "reply", body);
});
