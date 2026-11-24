// POST /api/app/mail/attachments/upload -- multipart/form-data { draftId, file }
// Validates count / per-file size / total size against mail policy, refuses
// executable file types, stores the bytes in the private R2 bucket and
// records metadata. A failed upload leaves the draft untouched.

import { loadPolicy } from "../../../../_lib/mail/config";
import { errorResponse, jsonResponse, nowIso } from "../../../../_lib/mail/http";
import { mailHandler } from "../../../../_lib/mail/route";
import { attachmentKey, isBlockedFilename, normalizeMimeType, sanitizeFilename } from "../../../../_lib/mail/storage";
import { serializeAttachment, type AttachmentRow } from "../../../../_lib/mail/store";

export const onRequestPost = mailHandler(async ({ ctx, db, user, access }) => {
  const bucket = ctx.env.MAIL_ATTACHMENTS;
  if (!bucket) return errorResponse(503, "Attachment storage is not configured.");
  const policy = await loadPolicy(db);
  const declared = Number(ctx.request.headers.get("content-length") || 0);
  if (declared > policy.maxAttachmentBytes + 1024 * 1024) return errorResponse(413, "File is too large.");
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    return errorResponse(400, "Expected a multipart form upload.");
  }
  const draftId = form.get("draftId");
  const file = form.get("file");
  if (typeof draftId !== "string" || !draftId) return errorResponse(400, "draftId is required.");
  if (!file || typeof file === "string") return errorResponse(400, "file is required.");
  const draft = await db.prepare(`SELECT id, account_id, created_by FROM mail_drafts WHERE id = ?`).bind(draftId).first<{ id: string; account_id: string; created_by: string }>();
  if (!draft || draft.created_by !== user.id || !access.get(draft.account_id)?.canSend) return errorResponse(404, "Draft not found.");

  const f = file as File;
  const filename = sanitizeFilename(f.name || "attachment");
  if (isBlockedFilename(filename)) return errorResponse(400, "This file type can't be attached for security reasons.");
  if (f.size <= 0) return errorResponse(400, "The file is empty.");
  if (f.size > policy.maxAttachmentBytes) return errorResponse(413, `Each attachment must be ${Math.round(policy.maxAttachmentBytes / 1024 / 1024)} MB or smaller.`);
  const totals = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM mail_attachments WHERE draft_id = ?`).bind(draftId).first<{ n: number; bytes: number }>();
  if ((totals?.n ?? 0) >= policy.maxAttachmentCount) return errorResponse(400, `At most ${policy.maxAttachmentCount} attachments per message.`);
  if ((totals?.bytes ?? 0) + f.size > policy.maxTotalAttachmentBytes) return errorResponse(413, `Attachments can total at most ${Math.round(policy.maxTotalAttachmentBytes / 1024 / 1024)} MB.`);

  const id = crypto.randomUUID();
  const key = attachmentKey(draft.account_id, draftId, id);
  const mimeType = normalizeMimeType(f.type);
  await bucket.put(key, f.stream(), { httpMetadata: { contentType: mimeType }, customMetadata: { filename, uploadedBy: user.id } });
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO mail_attachments (id, account_id, message_id, draft_id, filename, mime_type, size_bytes, storage_key, content_id, is_inline, storage_status, uploaded_by, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, 0, 'stored', ?, ?)`
    )
    .bind(id, draft.account_id, draftId, filename, mimeType, f.size, key, user.id, now)
    .run();
  const row: AttachmentRow = {
    id,
    account_id: draft.account_id,
    message_id: null,
    draft_id: draftId,
    filename,
    mime_type: mimeType,
    size_bytes: f.size,
    storage_key: key,
    content_id: null,
    is_inline: 0,
    storage_status: "stored",
    created_at: now,
  };
  return jsonResponse(201, serializeAttachment(row));
});
