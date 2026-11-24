// Shared body of POST /send, /reply, /reply-all, /forward and
// /drafts/:id/send: queue (transactional record first), then run the first
// SMTP attempt inline so the composer gets an immediate, honest result.

import { errorResponse, jsonResponse } from "./http";
import type { MailHandlerArgs } from "./route";
import { attemptSendJob, parseComposeBody, queueOutboundMessage, type ComposeMode } from "./send";
import { cloudflareSmtpTransport } from "./smtpTransport";

export async function handleSend<P extends string>(args: MailHandlerArgs<P>, mode: ComposeMode, body: Record<string, unknown>): Promise<Response> {
  const { ctx, db, user, access } = args;

  const parsed = parseComposeBody(body, mode);
  if (!parsed.ok) return errorResponse(400, parsed.error, parsed.invalid ? { invalid: parsed.invalid } : {});
  const queued = await queueOutboundMessage(ctx.env, user.id, access, parsed.input);
  if (!queued.ok) return errorResponse(queued.status, queued.error, queued.extra);

  if (!queued.existing) await attemptSendJob(ctx.env, queued.jobId, cloudflareSmtpTransport);
  return jobStatusResponse(db, { jobId: queued.jobId, messageId: queued.messageId, threadId: queued.threadId, duplicate: queued.existing });
}

export async function jobStatusResponse(db: D1Database, q: { jobId: string; messageId: string; threadId: string; duplicate: boolean }): Promise<Response> {
  const job = await db
    .prepare(`SELECT status, last_error, next_retry_at, attempts FROM mail_send_jobs WHERE id = ?`)
    .bind(q.jobId)
    .first<{ status: string; last_error: string | null; next_retry_at: string | null; attempts: number }>();
  return jsonResponse(q.duplicate ? 200 : 201, {
    jobId: q.jobId,
    messageId: q.messageId,
    threadId: q.threadId,
    duplicate: q.duplicate,
    status: job?.status ?? "queued",
    error: job?.last_error ?? null,
    nextRetryAt: job?.next_retry_at ?? null,
    attempts: job?.attempts ?? 0,
  });
}
