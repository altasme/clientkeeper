// Pure helpers that turn postal-mime's parse result into the shape the
// webmail store expects. No Workers APIs -- unit-tested under Node
// (tests/mail/inbound-parse.test.ts) against real MIME fixtures.

import type { Address, Email } from "postal-mime";
import { isValidEmail, normalizeEmail, type MailAddress } from "../../functions/_lib/mail/address";
import { htmlToText, makeSnippet } from "../../functions/_lib/mail/text";
import { normalizeMessageId } from "../../functions/_lib/mail/threading";

// D1 caps a single row/value at ~2 MB. Bodies beyond these limits are
// truncated in the database row (with a visible note); the complete
// original is always kept as the raw .eml in R2.
export const MAX_HTML_CHARS = 900_000;
export const MAX_TEXT_CHARS = 400_000;

export function flattenAddresses(list: Address[] | Address | undefined): MailAddress[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out: MailAddress[] = [];
  for (const a of arr) {
    if (a.group) {
      for (const m of a.group) if (m.address && isValidEmail(m.address)) out.push({ name: m.name || null, email: normalizeEmail(m.address) });
    } else if (a.address && isValidEmail(a.address)) {
      out.push({ name: a.name || null, email: normalizeEmail(a.address) });
    }
  }
  return out;
}

export interface NormalizedInbound {
  from: MailAddress;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  messageIdHeader: string | null;
  messageIdNormalized: string | null;
  inReplyTo: string | null;
  references: string | null;
  html: string;
  text: string;
  snippet: string;
  truncated: boolean;
  dateHeader: string | null;
  authResults: string | null;
  likelyJunk: boolean;
}

function headerValue(email: Email, key: string): string | null {
  const h = email.headers.find((x) => x.key === key);
  return h ? h.value.slice(0, 2000) : null;
}

/**
 * Basic junk signal. Cloudflare Email Routing performs SPF/DKIM/DMARC
 * checks and records them in Authentication-Results; it does not provide a
 * spam score. A message whose sending domain's own DMARC policy evaluation
 * failed is filed in Junk (never discarded -- staff can mark it Not Junk).
 * SPF-only failures are NOT treated as junk because ordinary forwarding
 * breaks SPF.
 */
export function isLikelyJunk(authResults: string | null): boolean {
  return !!authResults && /\bdmarc=fail\b/i.test(authResults);
}

export function normalizeParsed(email: Email, envelopeFrom: string): NormalizedInbound {
  const fromList = flattenAddresses(email.from);
  const envelope = isValidEmail(envelopeFrom) ? normalizeEmail(envelopeFrom) : "unknown-sender@invalid.invalid";
  const from = fromList[0] ?? { name: null, email: envelope };
  let html = email.html ?? "";
  let text = email.text ?? "";
  if (!text && html) text = htmlToText(html);
  let truncated = false;
  if (html.length > MAX_HTML_CHARS) {
    html = `${html.slice(0, MAX_HTML_CHARS)}<p><em>[This message was too large to show in full. Download the original to see everything.]</em></p>`;
    truncated = true;
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Message truncated. Download the original to see everything.]`;
    truncated = true;
  }
  const messageIdNormalized = normalizeMessageId(email.messageId);
  const authResults = headerValue(email, "authentication-results");
  return {
    from,
    replyTo: flattenAddresses(email.replyTo),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    subject: (email.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 1000),
    messageIdHeader: messageIdNormalized ? `<${messageIdNormalized}>` : null,
    messageIdNormalized,
    inReplyTo: email.inReplyTo ? email.inReplyTo.slice(0, 2000) : null,
    references: email.references ? email.references.slice(0, 8000) : null,
    html,
    text,
    snippet: makeSnippet(text),
    truncated,
    dateHeader: email.date ?? null,
    authResults,
    likelyJunk: isLikelyJunk(authResults),
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-mailbox dedupe key: the normalized Message-ID when present
 * (the standard unique identifier); otherwise a SHA-256 over the fields
 * that identify a specific message (sender, Date header, subject, the
 * start of the body), so a redelivered copy of a Message-ID-less email is
 * still recognized as the same message.
 */
export async function computeDedupeKey(n: NormalizedInbound): Promise<string> {
  if (n.messageIdNormalized) return `mid:${n.messageIdNormalized}`;
  return `hash:${await sha256Hex([n.from.email, n.dateHeader ?? "", n.subject, n.text.slice(0, 20_000), n.html.slice(0, 20_000)].join("\u0000"))}`;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/calendar": "ics",
  "message/rfc822": "eml",
};

export function attachmentFilename(name: string | null, mimeType: string, index: number): string {
  if (name && name.trim()) return name;
  return `attachment-${index + 1}.${EXT_BY_TYPE[mimeType.toLowerCase()] ?? "bin"}`;
}
