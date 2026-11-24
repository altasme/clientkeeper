// POST /api/app/mail/send/retry -- { messageId } manually retry a failed send.
// Grants a fresh attempt budget and runs one attempt immediately. Refuses
// anything that isn't failed/retry_scheduled (409), so it can never resend
// a message the server already accepted.

import { errorResponse, jsonResponse, readJsonBody } from "../../../../_lib/mail/http";
import { logMailEvent } from "../../../../_lib/mail/events";
import { mailHandler } from "../../../../_lib/mail/route";
import { retrySendJob } from "../../../../_lib/mail/send";
import { cloudflareSmtpTransport } from "../../../../_lib/mail/smtpTransport";

export const onRequestPost = mailHandler(async ({ ctx, db, user, access }) => {
  const body = await readJsonBody(ctx.request);
  if (!body || typeof body.messageId !== "string") return errorResponse(400, "messageId is required.");
  const result = await retrySendJob(ctx.env, access, body.messageId, cloudflareSmtpTransport);
  if (!result.ok) return errorResponse(result.status, result.error);
  await logMailEvent(db, { messageId: body.messageId, type: "send_manual_retry", data: { outcome: result.outcome.status }, actorId: user.id });
  return jsonResponse(200, { status: result.outcome.status, error: result.outcome.error ?? null });
});
