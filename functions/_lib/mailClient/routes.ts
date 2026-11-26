// Route logic for /api/mail-client/* (the mailbox-owner webmail API). The
// files under functions/api/mail-client/ are one-line bindings of these.
// They live here, importing only per-module @altasme/webmail-kit subpaths
// with the SMTP transport injected, so the exact handlers that run in
// production can also run under Node in tests (the package barrel pulls in
// `cloudflare:sockets`, which Node can't load -- see CLAUDE.md §33).
//
// Every handler is wrapped in mailClientHandler() (./handler.ts), and the
// ONLY mailbox any of them touches is `account.id` from the verified
// session, passed to the package as `[account.id]` or as the one-entry
// `access` map. No handler reads an account id from the URL or body:
//   - list/search ignore any `accountId` query parameter;
//   - send refuses a body whose `accountId` differs from the session's
//     (404, as for any mailbox the caller can't see), and otherwise forces
//     the session's own id;
//   - a message/thread/attachment id from another mailbox is 404, exactly
//     like the staff routes' IDOR posture.
//
// Deliberately NOT exposed here: labels management, identities, access
// grants, settings/signatures, raw .eml download, permanent delete, retry,
// and drafts. Drafts are blocked by the schema, not by choice:
// mail_drafts.created_by is NOT NULL REFERENCES users(id), and a mailbox
// owner has no users row (D1 enforces foreign keys). See CLAUDE.md §36.

import { applyMessageAction } from "@altasme/webmail-kit/actions";
import { buildPrefill, loadSignatures, signatureBlock } from "@altasme/webmail-kit/compose";
import { loadMessageDetails } from "@altasme/webmail-kit/detail";
import { authorizeAttachment, contentDisposition } from "@altasme/webmail-kit/drafts";
import { errorResponse, jsonResponse, normalizeParam, readJsonBody } from "@altasme/webmail-kit/http";
import { listThreads, parseListParams } from "@altasme/webmail-kit/query";
import { attemptSendJob, parseComposeBody, queueOutboundMessageAsMailboxOwner, type ComposeMode } from "@altasme/webmail-kit/send";
import type { SmtpTransport } from "@altasme/webmail-kit/smtpTransport";
import { isPreviewable } from "@altasme/webmail-kit/storage";
import { loadMessages } from "@altasme/webmail-kit/store";
import { mailClientHandler, type MailClientHandlerArgs } from "./handler";

export const CLIENT_ATTACHMENT_BASE = "/api/mail-client/attachments";

const FOLDERS = new Set(["inbox", "sent", "archive", "junk", "trash", "starred", "all"]);

// GET /api/mail-client/me
export const me = mailClientHandler(async ({ account }) =>
  jsonResponse(200, { emailAddress: account.emailAddress, displayName: account.displayName, canSend: account.outboundEnabled })
);

// GET /api/mail-client/messages?folder=&q=&unread=1&starred=1&hasAttachments=1&from=&to=&dateFrom=&dateTo=&sort=&limit=&offset=
// Conversation list for one folder, or a search when `q`/filters are given.
// Any accountId parameter is ignored: the list is always the session's mailbox.
export const listMessagesRoute = mailClientHandler(async ({ ctx, db, account }) => {
  const url = new URL(ctx.request.url);
  const params = parseListParams(url);
  if (!FOLDERS.has(params.folder)) return errorResponse(400, "Unknown folder.");
  const result = await listThreads(db, [account.id], params);
  return jsonResponse(200, { ...result, offset: params.offset, limit: params.limit });
});

async function loadOwnMessage({ db, account }: MailClientHandlerArgs<"id">, id: string) {
  const [row] = await loadMessages(db, [id], [account.id]);
  return row ?? null;
}

// GET   /api/mail-client/messages/:id[?remoteImages=1]
// PATCH /api/mail-client/messages/:id -- { isRead?, isStarred? }
export const getMessageRoute = mailClientHandler<"id">(async ({ ctx, db, account }) => {
  const id = normalizeParam(ctx.params.id);
  const remote = new URL(ctx.request.url).searchParams.get("remoteImages") === "1";
  const [detail] = await loadMessageDetails(db, [account.id], { messageIds: [id] }, remote, CLIENT_ATTACHMENT_BASE);
  if (!detail) return errorResponse(404, "Message not found.");
  return jsonResponse(200, detail);
});

export const patchMessageRoute = mailClientHandler<"id">(async (args) => {
  const { ctx, db, user, account } = args;
  const id = normalizeParam(ctx.params.id);
  if (!(await loadOwnMessage(args, id))) return errorResponse(404, "Message not found.");
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const scope = { ids: [id], accountIds: [account.id], actorId: user.id };
  if (typeof body.isRead === "boolean") await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ...scope, action: body.isRead ? "markRead" : "markUnread" });
  if (typeof body.isStarred === "boolean") await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ...scope, action: body.isStarred ? "star" : "unstar" });
  const updated = await loadOwnMessage(args, id);
  return jsonResponse(200, { id, isRead: !!updated?.is_read, isStarred: !!updated?.is_starred, folder: updated?.folder });
});

// POST /api/mail-client/messages/:id/move -- { to: "inbox" | "archive" | "junk" | "trash" }
// "inbox" restores from Archive, Junk or Trash. Never a permanent delete
// (Trash is purged after 30 days by the mail worker).
export const moveMessageRoute = mailClientHandler<"id">(async (args) => {
  const { ctx, db, user, account } = args;
  const id = normalizeParam(ctx.params.id);
  const row = await loadOwnMessage(args, id);
  if (!row) return errorResponse(404, "Message not found.");
  const body = await readJsonBody(ctx.request);
  const to = body?.to;
  let action: "archive" | "junk" | "trash" | "moveToInbox" | "restore";
  if (to === "archive" || to === "junk" || to === "trash") action = to;
  else if (to === "inbox") action = row.folder === "archive" ? "moveToInbox" : "restore";
  else return errorResponse(400, "to must be inbox, archive, junk or trash.");
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: [account.id], action, actorId: user.id });
  if (!result.ok) return errorResponse(result.status, result.error);
  const updated = await loadOwnMessage(args, id);
  return jsonResponse(200, { ok: true, changed: result.affected > 0, folder: updated?.folder });
});

// GET /api/mail-client/threads/:id?context=<folder>[&remoteImages=1]
export const getThreadRoute = mailClientHandler<"id">(async ({ ctx, db, account }) => {
  const id = normalizeParam(ctx.params.id);
  const url = new URL(ctx.request.url);
  const context = url.searchParams.get("context") ?? "inbox";
  const remote = url.searchParams.get("remoteImages") === "1";
  const thread = await db
    .prepare(`SELECT id, account_id, subject FROM mail_threads WHERE id = ? AND account_id = ?`)
    .bind(id, account.id)
    .first<{ id: string; account_id: string; subject: string }>();
  if (!thread) return errorResponse(404, "Conversation not found.");
  const includeFolders = context === "trash" ? null : context === "junk" ? ["inbox", "sent", "archive", "junk"] : ["inbox", "sent", "archive"];
  const messages = await loadMessageDetails(db, [account.id], { threadId: id, folders: includeFolders }, remote, CLIENT_ATTACHMENT_BASE);
  return jsonResponse(200, { id: thread.id, subject: thread.subject, messages });
});

// GET /api/mail-client/compose?mode=new|reply|reply_all|forward&sourceMessageId=
// Server-side prefill (recipients by the Reply/Reply-All rules, Re:/Fwd:
// subject, quoted sanitized original, signature). Creates nothing.
// A forward does NOT carry the original's attachments: that hand-over
// works through a draft, which a mailbox owner can't have (see top).
export const composePrefillRoute = mailClientHandler(async ({ ctx, db, account, access }) => {
  const url = new URL(ctx.request.url);
  const mode = url.searchParams.get("mode") ?? "new";
  if (mode === "new") {
    const sig = (await loadSignatures(db, [account.id])).find((s) => s.use_for_new);
    return jsonResponse(200, { mode, to: [], cc: [], subject: "", bodyHtml: sig ? `<p><br></p>${signatureBlock(sig.body_html)}` : "", sourceMessageId: null });
  }
  if (mode !== "reply" && mode !== "reply_all" && mode !== "forward") return errorResponse(400, "Unknown compose mode.");
  const sourceMessageId = url.searchParams.get("sourceMessageId") ?? "";
  if (!sourceMessageId) return errorResponse(400, "sourceMessageId is required for replies and forwards.");
  const prefill = await buildPrefill(db, access, account.id, mode, sourceMessageId);
  if (!prefill) return errorResponse(404, "Original message not found.");
  return jsonResponse(200, { mode, to: prefill.to, cc: prefill.cc, subject: prefill.subject, bodyHtml: prefill.bodyHtml, sourceMessageId });
});

const MODES = new Set<ComposeMode>(["new", "reply", "reply_all", "forward"]);

// POST /api/mail-client/send -- { mode, to, cc, bcc, subject, html, idempotencyKey, sourceMessageId? }
// Response: { jobId, messageId, threadId, duplicate, status, error, ... }
// "sent" means the SMTP server accepted the message, never "delivered".
export function sendRoute(transport: SmtpTransport) {
  return mailClientHandler(async ({ ctx, db, account, access }) => {
    const body = await readJsonBody(ctx.request);
    if (!body) return errorResponse(400, "Invalid request body");
    if (body.accountId !== undefined && body.accountId !== account.id) return errorResponse(404, "Mailbox not found.");
    if (body.draftId !== undefined && body.draftId !== null) return errorResponse(404, "Draft not found.");
    const mode = (typeof body.mode === "string" ? body.mode : "new") as ComposeMode;
    if (!MODES.has(mode)) return errorResponse(400, "Unknown compose mode.");
    const parsed = parseComposeBody({ ...body, accountId: account.id, draftId: null }, mode);
    if (!parsed.ok) return errorResponse(400, parsed.error, parsed.invalid ? { invalid: parsed.invalid } : {});
    const queued = await queueOutboundMessageAsMailboxOwner(ctx.env, account.id, access, parsed.input);
    if (!queued.ok) return errorResponse(queued.status, queued.error, queued.extra);
    if (!queued.existing) await attemptSendJob(ctx.env, queued.jobId, transport);
    const job = await db
      .prepare(`SELECT status, last_error, next_retry_at, attempts FROM mail_send_jobs WHERE id = ? AND account_id = ?`)
      .bind(queued.jobId, account.id)
      .first<{ status: string; last_error: string | null; next_retry_at: string | null; attempts: number }>();
    return jsonResponse(queued.existing ? 200 : 201, {
      jobId: queued.jobId,
      messageId: queued.messageId,
      threadId: queued.threadId,
      duplicate: queued.existing,
      status: job?.status ?? "queued",
      error: job?.last_error ?? null,
      nextRetryAt: job?.next_retry_at ?? null,
      attempts: job?.attempts ?? 0,
    });
  });
}

// Attachments of the session's own MESSAGES only. authorizeAttachment()
// already scopes a message attachment to accessible mailboxes; a draft
// attachment is refused outright here (a mailbox owner has no drafts).
async function ownMessageAttachment({ ctx, db, user, access }: MailClientHandlerArgs<"id">) {
  const att = await authorizeAttachment(db, access, user.id, normalizeParam(ctx.params.id));
  return att && att.message_id ? att : null;
}

// GET /api/mail-client/attachments/:id -- always a download
export const downloadAttachmentRoute = mailClientHandler<"id">(async (args) => {
  const att = await ownMessageAttachment(args);
  if (!att) return errorResponse(404, "Attachment not found.");
  if (att.storage_status !== "stored") return errorResponse(410, "This attachment could not be stored when the email arrived.");
  const obj = args.ctx.env.MAIL_ATTACHMENTS ? await args.ctx.env.MAIL_ATTACHMENTS.get(att.storage_key) : null;
  if (!obj) return errorResponse(410, "This attachment is no longer available.");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": contentDisposition("attachment", att.filename),
      "content-length": String(obj.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});

// GET /api/mail-client/attachments/:id/preview -- safe types only, same
// headers as the staff preview route (also serves cid: inline images).
export const previewAttachmentRoute = mailClientHandler<"id">(async (args) => {
  const att = await ownMessageAttachment(args);
  if (!att) return errorResponse(404, "Attachment not found.");
  if (att.storage_status !== "stored") return errorResponse(410, "This attachment could not be stored when the email arrived.");
  const type = att.mime_type.toLowerCase();
  if (!isPreviewable(type)) return errorResponse(415, "Preview isn't available for this file type. Download it instead.");
  const obj = args.ctx.env.MAIL_ATTACHMENTS ? await args.ctx.env.MAIL_ATTACHMENTS.get(att.storage_key) : null;
  if (!obj) return errorResponse(410, "This attachment is no longer available.");
  const isText = type.startsWith("text/");
  return new Response(obj.body, {
    headers: {
      "content-type": isText ? "text/plain; charset=utf-8" : type,
      "content-disposition": contentDisposition("inline", att.filename),
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": type === "application/pdf" ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'",
    },
  });
});
