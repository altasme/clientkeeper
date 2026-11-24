// Composer prefill for reply / reply-all / forward drafts and signatures.
// Built server-side so Reply-All recipient rules, subject prefixes,
// threading context and forwarded attachments have exactly one
// implementation.

import { parseAddressList, type MailAddress } from "./address";
import type { MailAccess } from "./access";
import { sanitizeEmailHtml } from "./sanitize";
import { MESSAGE_COLUMNS, loadRecipients, type MessageRow } from "./store";
import { escapeHtml, forwardSubject, replySubject, textToHtml } from "./text";
import { computeReplyRecipients } from "./threading";
import type { ComposeMode } from "./send";

export interface SignatureRow {
  id: string;
  account_id: string;
  name: string;
  body_html: string;
  body_text: string;
  use_for_new: number;
  use_for_reply: number;
}

export function serializeSignature(s: SignatureRow) {
  return { id: s.id, accountId: s.account_id, name: s.name, bodyHtml: s.body_html, bodyText: s.body_text, useForNew: !!s.use_for_new, useForReply: !!s.use_for_reply };
}

export async function loadSignatures(db: D1Database, accountIds: string[]): Promise<SignatureRow[]> {
  if (!accountIds.length) return [];
  const rows = await db
    .prepare(`SELECT id, account_id, name, body_html, body_text, use_for_new, use_for_reply FROM mail_signatures WHERE account_id IN (${accountIds.map(() => "?").join(", ")}) ORDER BY name`)
    .bind(...accountIds)
    .all<SignatureRow>();
  return rows.results;
}

/** The composer wraps the signature in a marker div so switching From identity can swap it client-side. */
export function signatureBlock(html: string): string {
  return html ? `<div data-mail-signature="1"><br>-- <br>${html}</div>` : "";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

function fmt(a: { name: string | null; email: string }): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export interface DraftPrefill {
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  bodyHtml: string;
  threadId: string | null;
  sourceAccountId: string;
}

export async function buildPrefill(db: D1Database, access: MailAccess, accountId: string, mode: Exclude<ComposeMode, "new">, sourceMessageId: string): Promise<DraftPrefill | null> {
  const ids = [...access.keys()];
  if (!ids.length) return null;
  const src = await db
    .prepare(`SELECT ${MESSAGE_COLUMNS}, body_html, body_text FROM mail_messages WHERE id = ? AND account_id IN (${ids.map(() => "?").join(", ")})`)
    .bind(sourceMessageId, ...ids)
    .first<MessageRow & { body_html: string; body_text: string }>();
  if (!src) return null;
  const recipients = (await loadRecipients(db, [src.id])).get(src.id) ?? [];
  const toList = recipients.filter((r) => r.type === "to").map((r) => ({ name: r.name, email: r.email }));
  const ccList = recipients.filter((r) => r.type === "cc").map((r) => ({ name: r.name, email: r.email }));
  const own = [...access.values()].map((a) => a.emailAddress);
  const sending = access.get(accountId)?.emailAddress ?? "";

  // The quoted original is the SANITIZED html (remote images blocked) -- the
  // composer never re-embeds raw untrusted markup.
  const { html: safeHtml } = await sanitizeEmailHtml(src.body_html, { allowRemoteImages: false, cidMap: new Map() });
  const originalBody = safeHtml || textToHtml(src.body_text);
  const when = formatDate(src.received_at ?? src.sent_at ?? src.created_at);

  let to: MailAddress[] = [];
  let cc: MailAddress[] = [];
  let subject: string;
  let quote: string;
  if (mode === "forward") {
    subject = forwardSubject(src.subject);
    quote = `<p>---------- Forwarded message ----------<br>From: ${escapeHtml(fmt({ name: src.from_name, email: src.from_email }))}<br>Date: ${escapeHtml(when)}<br>Subject: ${escapeHtml(
      src.subject
    )}<br>To: ${escapeHtml(toList.map(fmt).join(", "))}${ccList.length ? `<br>Cc: ${escapeHtml(ccList.map(fmt).join(", "))}` : ""}</p>${originalBody}`;
  } else {
    const replyTo = src.reply_to ? parseAddressList(src.reply_to).valid : [];
    const r = computeReplyRecipients(
      { direction: src.direction, from: { name: src.from_name, email: src.from_email }, replyTo, to: toList, cc: ccList },
      mode,
      sending,
      own
    );
    to = r.to;
    cc = r.cc;
    subject = replySubject(src.subject);
    quote = `<p>On ${escapeHtml(when)}, ${escapeHtml(fmt({ name: src.from_name, email: src.from_email }))} wrote:</p><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${originalBody}</blockquote>`;
  }

  const sig = (await loadSignatures(db, [accountId])).find((s) => (mode === "forward" ? s.use_for_new : s.use_for_reply));
  const bodyHtml = `<p><br></p>${signatureBlock(sig?.body_html ?? "")}<br>${quote}`;
  return { to, cc, subject, bodyHtml, threadId: src.account_id === accountId ? src.thread_id : null, sourceAccountId: src.account_id };
}
