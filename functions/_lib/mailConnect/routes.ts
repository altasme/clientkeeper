// Route logic for the /api/mail-connect/* data routes (the Webmail Connect
// webmail API). The files under functions/api/mail-connect/ are one-line
// bindings of these. Like ../mailClient/routes.ts, they import only
// per-module @altasme/webmail-kit subpaths with the SMTP transport
// injected, so the handlers that run in production also run under Node in
// tests (CLAUDE.md §33).
//
// Every handler is wrapped in mailConnectHandler() (./handler.ts), which
// hands it the caller's LIVE grants, read for this request. A handler that
// works on one mailbox resolves the request's explicit mailboxId (query on
// GET, JSON body on writes) with requireGrant(), and then passes the
// package only that one mailbox (`[grant.mailAccountId]` or the one-entry
// `access` map). Per-permission enforcement, all server-side:
//   read     every route (a grant without can_read is no grant)
//   send     compose prefill, send
//   delete   moving a message to Trash
//   settings creating a signature
// The UI hiding a button is cosmetic; these checks are the control.
//
// Attachments are the one exception to "explicit mailboxId": an
// attachment id is global and its URL is embedded in message HTML (cid:
// images), so the attachment routes authorize against the union of the
// caller's readable grants instead. Still server-side, still 404 for
// anything outside them.
//
// Not exposed, same reasons as the mailbox-owner API (CLAUDE.md §37.4):
// drafts/autosave and uploads (mail_drafts.created_by references users),
// labels, identities, access grants, raw download, permanent delete, retry.

import { applyMessageAction } from "@altasme/webmail-kit/actions";
import { buildPrefill, loadSignatures, serializeSignature, signatureBlock } from "@altasme/webmail-kit/compose";
import { loadMessageDetails } from "@altasme/webmail-kit/detail";
import { authorizeAttachment, contentDisposition } from "@altasme/webmail-kit/drafts";
import { logMailEvent } from "@altasme/webmail-kit/events";
import { asString, errorResponse, jsonResponse, normalizeParam, readJsonBody } from "@altasme/webmail-kit/http";
import { listThreads, parseListParams } from "@altasme/webmail-kit/query";
import { sanitizeOutboundHtml } from "@altasme/webmail-kit/sanitize";
import { attemptSendJob, parseComposeBody, queueOutboundMessageAsMailboxOwner, type ComposeMode } from "@altasme/webmail-kit/send";
import type { SmtpTransport } from "@altasme/webmail-kit/smtpTransport";
import { isPreviewable } from "@altasme/webmail-kit/storage";
import { loadMessages } from "@altasme/webmail-kit/store";
import { htmlToText } from "@altasme/webmail-kit/text";
import { accessFor } from "./account";
import { parseReturnUrl } from "./admin";
import { mailConnectHandler, requireGrant, type MailConnectHandlerArgs } from "./handler";

export const CONNECT_ATTACHMENT_BASE = "/api/mail-connect/attachments";

const FOLDERS = new Set(["inbox", "sent", "archive", "junk", "trash", "starred", "all"]);
const MODES = new Set<ComposeMode>(["new", "reply", "reply_all", "forward"]);

const queryMailboxId = (ctx: { request: Request }) => new URL(ctx.request.url).searchParams.get("mailboxId");

// GET /api/mail-connect/me
// Who the session is, the mailboxes they can open right now (with
// permissions, default first), how many granted mailboxes are currently
// unavailable, and where "Back to <panel>" goes.
export const me = mailConnectHandler(async ({ db, session, integration, grants, unavailableCount }) => {
  const launch = await db
    .prepare(`SELECT return_url FROM mail_launch_codes WHERE id = ? AND integration_id = ? AND external_user_id = ?`)
    .bind(session.launchId, integration.id, session.externalUserId)
    .first<{ return_url: string | null }>();
  const returnUrl = parseReturnUrl(launch?.return_url ?? null);
  return jsonResponse(200, {
    integrationName: integration.name,
    returnUrl: returnUrl.ok ? returnUrl.value : null,
    unavailableCount,
    mailboxes: grants.map((g) => ({
      id: g.mailAccountId,
      emailAddress: g.emailAddress,
      displayName: g.displayName,
      canSend: g.canSend && g.outboundEnabled,
      canDelete: g.canDelete,
      canManageSettings: g.canManageSettings,
      isDefault: g.isDefault,
    })),
  });
});

// GET /api/mail-connect/messages?mailboxId=&folder=&q=&...
export const listMessagesRoute = mailConnectHandler(async ({ ctx, db, grants }) => {
  const g = requireGrant(grants, queryMailboxId(ctx));
  if (!g.ok) return g.response;
  const params = parseListParams(new URL(ctx.request.url));
  if (!FOLDERS.has(params.folder)) return errorResponse(400, "Unknown folder.");
  const result = await listThreads(db, [g.grant.mailAccountId], params);
  return jsonResponse(200, { ...result, offset: params.offset, limit: params.limit });
});

async function loadMessageIn(db: D1Database, mailboxId: string, id: string) {
  const [row] = await loadMessages(db, [id], [mailboxId]);
  return row ?? null;
}

// GET /api/mail-connect/messages/:id?mailboxId=[&remoteImages=1]
export const getMessageRoute = mailConnectHandler<"id">(async ({ ctx, db, grants }) => {
  const g = requireGrant(grants, queryMailboxId(ctx));
  if (!g.ok) return g.response;
  const id = normalizeParam(ctx.params.id);
  const remote = new URL(ctx.request.url).searchParams.get("remoteImages") === "1";
  const [detail] = await loadMessageDetails(db, [g.grant.mailAccountId], { messageIds: [id] }, remote, CONNECT_ATTACHMENT_BASE);
  if (!detail) return errorResponse(404, "Message not found.");
  return jsonResponse(200, detail);
});

// PATCH /api/mail-connect/messages/:id -- { mailboxId, isRead?, isStarred? }
export const patchMessageRoute = mailConnectHandler<"id">(async ({ ctx, db, user, grants }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const g = requireGrant(grants, body.mailboxId);
  if (!g.ok) return g.response;
  const mailboxId = g.grant.mailAccountId;
  const id = normalizeParam(ctx.params.id);
  if (!(await loadMessageIn(db, mailboxId, id))) return errorResponse(404, "Message not found.");
  const scope = { ids: [id], accountIds: [mailboxId], actorId: user.id };
  if (typeof body.isRead === "boolean") await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ...scope, action: body.isRead ? "markRead" : "markUnread" });
  if (typeof body.isStarred === "boolean") await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ...scope, action: body.isStarred ? "star" : "unstar" });
  const updated = await loadMessageIn(db, mailboxId, id);
  return jsonResponse(200, { id, isRead: !!updated?.is_read, isStarred: !!updated?.is_starred, folder: updated?.folder });
});

// POST /api/mail-connect/messages/:id/move -- { mailboxId, to: inbox | archive | junk | trash }
// "trash" needs the delete permission. Never a permanent delete.
export const moveMessageRoute = mailConnectHandler<"id">(async ({ ctx, db, user, grants }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const to = body.to;
  if (to !== "inbox" && to !== "archive" && to !== "junk" && to !== "trash") return errorResponse(400, "to must be inbox, archive, junk or trash.");
  const g = requireGrant(grants, body.mailboxId, to === "trash" ? "delete" : "read");
  if (!g.ok) return g.response;
  const mailboxId = g.grant.mailAccountId;
  const id = normalizeParam(ctx.params.id);
  const row = await loadMessageIn(db, mailboxId, id);
  if (!row) return errorResponse(404, "Message not found.");
  const action = to === "inbox" ? (row.folder === "archive" ? "moveToInbox" : "restore") : to;
  const result = await applyMessageAction(db, ctx.env.MAIL_ATTACHMENTS, { ids: [id], accountIds: [mailboxId], action, actorId: user.id });
  if (!result.ok) return errorResponse(result.status, result.error);
  const updated = await loadMessageIn(db, mailboxId, id);
  return jsonResponse(200, { ok: true, changed: result.affected > 0, folder: updated?.folder });
});

// GET /api/mail-connect/threads/:id?mailboxId=&context=<folder>[&remoteImages=1]
export const getThreadRoute = mailConnectHandler<"id">(async ({ ctx, db, grants }) => {
  const g = requireGrant(grants, queryMailboxId(ctx));
  if (!g.ok) return g.response;
  const mailboxId = g.grant.mailAccountId;
  const id = normalizeParam(ctx.params.id);
  const url = new URL(ctx.request.url);
  const context = url.searchParams.get("context") ?? "inbox";
  const remote = url.searchParams.get("remoteImages") === "1";
  const thread = await db
    .prepare(`SELECT id, subject FROM mail_threads WHERE id = ? AND account_id = ?`)
    .bind(id, mailboxId)
    .first<{ id: string; subject: string }>();
  if (!thread) return errorResponse(404, "Conversation not found.");
  const includeFolders = context === "trash" ? null : context === "junk" ? ["inbox", "sent", "archive", "junk"] : ["inbox", "sent", "archive"];
  const messages = await loadMessageDetails(db, [mailboxId], { threadId: id, folders: includeFolders }, remote, CONNECT_ATTACHMENT_BASE);
  return jsonResponse(200, { id: thread.id, subject: thread.subject, messages });
});

// GET /api/mail-connect/compose?mailboxId=&mode=new|reply|reply_all|forward&sourceMessageId=
// Prefill only; creates nothing. Needs the send permission.
export const composePrefillRoute = mailConnectHandler(async ({ ctx, db, grants }) => {
  const url = new URL(ctx.request.url);
  const g = requireGrant(grants, url.searchParams.get("mailboxId"), "send");
  if (!g.ok) return g.response;
  const mailboxId = g.grant.mailAccountId;
  const mode = url.searchParams.get("mode") ?? "new";
  if (mode === "new") {
    const sig = (await loadSignatures(db, [mailboxId])).find((s) => s.use_for_new);
    return jsonResponse(200, { mode, to: [], cc: [], subject: "", bodyHtml: sig ? `<p><br></p>${signatureBlock(sig.body_html)}` : "", sourceMessageId: null });
  }
  if (mode !== "reply" && mode !== "reply_all" && mode !== "forward") return errorResponse(400, "Unknown compose mode.");
  const sourceMessageId = url.searchParams.get("sourceMessageId") ?? "";
  if (!sourceMessageId) return errorResponse(400, "sourceMessageId is required for replies and forwards.");
  const prefill = await buildPrefill(db, g.access, mailboxId, mode, sourceMessageId);
  if (!prefill) return errorResponse(404, "Original message not found.");
  return jsonResponse(200, { mode, to: prefill.to, cc: prefill.cc, subject: prefill.subject, bodyHtml: prefill.bodyHtml, sourceMessageId });
});

// POST /api/mail-connect/send -- { mailboxId, mode, to, cc, bcc, subject, html, idempotencyKey, sourceMessageId? }
// Sends FROM mailboxId only, and only with the send permission (403
// otherwise, checked here before anything is queued). Recorded like a
// mailbox-owner send (created_by NULL, per-mailbox idempotency and hourly
// limit); an extra mail_events row records which connect user sent it.
export function sendRoute(transport: SmtpTransport) {
  return mailConnectHandler(async ({ ctx, db, user, grants }) => {
    const body = await readJsonBody(ctx.request);
    if (!body) return errorResponse(400, "Invalid request body");
    const g = requireGrant(grants, body.mailboxId, "send");
    if (!g.ok) return g.response;
    const mailboxId = g.grant.mailAccountId;
    if (body.draftId !== undefined && body.draftId !== null) return errorResponse(404, "Draft not found.");
    const mode = (typeof body.mode === "string" ? body.mode : "new") as ComposeMode;
    if (!MODES.has(mode)) return errorResponse(400, "Unknown compose mode.");
    const parsed = parseComposeBody({ ...body, accountId: mailboxId, draftId: null }, mode);
    if (!parsed.ok) return errorResponse(400, parsed.error, parsed.invalid ? { invalid: parsed.invalid } : {});
    const queued = await queueOutboundMessageAsMailboxOwner(ctx.env, mailboxId, g.access, parsed.input);
    if (!queued.ok) return errorResponse(queued.status, queued.error, queued.extra);
    if (!queued.existing) {
      await logMailEvent(db, { accountId: mailboxId, messageId: queued.messageId, type: "connect_send", data: { jobId: queued.jobId }, actorId: user.id });
      await attemptSendJob(ctx.env, queued.jobId, transport);
    }
    const job = await db
      .prepare(`SELECT status, last_error, next_retry_at, attempts FROM mail_send_jobs WHERE id = ? AND account_id = ?`)
      .bind(queued.jobId, mailboxId)
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

// GET  /api/mail-connect/signatures?mailboxId=   (read)
// POST /api/mail-connect/signatures  { mailboxId, name, bodyHtml, useForNew?, useForReply? }  (settings permission)
export const listSignaturesRoute = mailConnectHandler(async ({ ctx, db, grants }) => {
  const g = requireGrant(grants, queryMailboxId(ctx));
  if (!g.ok) return g.response;
  return jsonResponse(200, { signatures: (await loadSignatures(db, [g.grant.mailAccountId])).map(serializeSignature) });
});

export const createSignatureRoute = mailConnectHandler(async ({ ctx, db, user, grants }) => {
  const body = await readJsonBody(ctx.request);
  if (!body) return errorResponse(400, "Invalid request body");
  const g = requireGrant(grants, body.mailboxId, "settings");
  if (!g.ok) return g.response;
  const mailboxId = g.grant.mailAccountId;
  const name = asString(body.name, 100).trim();
  if (!name) return errorResponse(400, "Signature name is required.");
  const html = await sanitizeOutboundHtml(asString(body.bodyHtml, 50_000));
  const useForNew = body.useForNew === true;
  const useForReply = body.useForReply === true;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  if (useForNew) stmts.push(db.prepare(`UPDATE mail_signatures SET use_for_new = 0 WHERE account_id = ?`).bind(mailboxId));
  if (useForReply) stmts.push(db.prepare(`UPDATE mail_signatures SET use_for_reply = 0 WHERE account_id = ?`).bind(mailboxId));
  stmts.push(
    db
      .prepare(`INSERT INTO mail_signatures (id, account_id, name, body_html, body_text, use_for_new, use_for_reply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, mailboxId, name, html, htmlToText(html), useForNew ? 1 : 0, useForReply ? 1 : 0, now, now)
  );
  await db.batch(stmts);
  await logMailEvent(db, { accountId: mailboxId, messageId: null, type: "connect_signature_created", data: { signatureId: id }, actorId: user.id });
  return jsonResponse(201, { id });
});

// Attachments of messages in any mailbox the caller can read right now.
// Draft attachments are refused outright (connect users have no drafts).
async function readableAttachment({ ctx, db, user, grants }: MailConnectHandlerArgs<"id">) {
  const att = await authorizeAttachment(db, accessFor(grants), user.id, normalizeParam(ctx.params.id));
  return att && att.message_id ? att : null;
}

// GET /api/mail-connect/attachments/:id -- always a download
export const downloadAttachmentRoute = mailConnectHandler<"id">(async (args) => {
  const att = await readableAttachment(args);
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

// GET /api/mail-connect/attachments/:id/preview -- safe types only, same headers as the other preview routes
export const previewAttachmentRoute = mailConnectHandler<"id">(async (args) => {
  const att = await readableAttachment(args);
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
