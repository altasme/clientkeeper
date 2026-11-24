// Draft + attachment authorization helpers. Drafts are private to the
// staff member who started them (even in a shared mailbox) -- nobody else
// sees or can edit someone's half-written email.

import { hasLineBreak, type MailAddress } from "./address";
import type { MailAccess } from "./access";
import { loadAttachmentsFor, serializeAttachment, type AttachmentRow } from "./store";
import { makeSnippet } from "./text";

export interface DraftRow {
  id: string;
  account_id: string;
  thread_id: string | null;
  compose_mode: "new" | "reply" | "reply_all" | "forward";
  source_message_id: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_html: string;
  body_text: string;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function parseList(json: string): MailAddress[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as MailAddress[]) : [];
  } catch {
    return [];
  }
}

/**
 * Drafts keep whatever the user typed, even an address that isn't valid
 * yet (it's validated at send time) -- an autosave must never silently
 * drop content. Only shape and length are enforced here.
 */
export function coerceDraftAddresses(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return [];
  const out: MailAddress[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const email = typeof o.email === "string" ? o.email.trim().slice(0, 320) : "";
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 200) : null;
    if (!email || hasLineBreak(email) || (name && hasLineBreak(name))) continue;
    out.push({ name: name || null, email });
  }
  return out;
}

export function serializeDraftSummary(d: DraftRow & { attachment_count?: number }) {
  return {
    id: d.id,
    accountId: d.account_id,
    composeMode: d.compose_mode,
    to: parseList(d.to_json),
    subject: d.subject,
    snippet: makeSnippet(d.body_text || ""),
    attachmentCount: d.attachment_count ?? 0,
    updatedAt: d.updated_at,
  };
}

export async function loadDraft(db: D1Database, access: MailAccess, userId: string, id: string) {
  const d = await db.prepare(`SELECT * FROM mail_drafts WHERE id = ?`).bind(id).first<DraftRow>();
  if (!d || d.created_by !== userId || !access.has(d.account_id)) return null;
  const atts = (await loadAttachmentsFor(db, "draft_id", [id])).get(id) ?? [];
  return {
    id: d.id,
    accountId: d.account_id,
    threadId: d.thread_id,
    composeMode: d.compose_mode,
    sourceMessageId: d.source_message_id,
    to: parseList(d.to_json),
    cc: parseList(d.cc_json),
    bcc: parseList(d.bcc_json),
    subject: d.subject,
    bodyHtml: d.body_html,
    version: d.version,
    attachments: atts.map(serializeAttachment),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Loads an attachment if (and only if) the caller may see it: its message's mailbox is accessible, or it's on their own draft. */
export async function authorizeAttachment(db: D1Database, access: MailAccess, userId: string, id: string): Promise<AttachmentRow | null> {
  const a = await db
    .prepare(`SELECT id, account_id, message_id, draft_id, filename, mime_type, size_bytes, storage_key, content_id, is_inline, storage_status, created_at FROM mail_attachments WHERE id = ?`)
    .bind(id)
    .first<AttachmentRow>();
  if (!a) return null;
  if (a.message_id) {
    const m = await db.prepare(`SELECT account_id FROM mail_messages WHERE id = ?`).bind(a.message_id).first<{ account_id: string }>();
    return m && access.has(m.account_id) ? a : null;
  }
  if (a.draft_id) {
    const d = await db.prepare(`SELECT account_id, created_by FROM mail_drafts WHERE id = ?`).bind(a.draft_id).first<{ account_id: string; created_by: string }>();
    return d && d.created_by === userId && access.has(d.account_id) ? a : null;
  }
  return null;
}

/** RFC 6266 Content-Disposition with an ASCII fallback + RFC 5987 UTF-8 filename. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
