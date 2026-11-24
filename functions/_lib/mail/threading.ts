// Standard email threading: Message-ID / In-Reply-To / References are the
// primary (and only) thread-matching mechanism. Subject is never used to
// join an existing thread -- two unrelated "Invoice" emails stay separate.
// This codebase had no prior inbound mail or threading implementation to
// preserve (audited 2026-11-24: the only mail code was the outbound-only
// Resend template helper in functions/_lib/email.ts).

import { dedupeAddresses, isAutomatedAddress, normalizeEmail, type MailAddress } from "./address";

/** "<ABC@x.com>" -> "abc@x.com". Returns null for empty input. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^<+|>+$/g, "").trim().toLowerCase();
  return v && !/[\s<>]/.test(v) ? v : null;
}

/** Extracts every <id> from a References / In-Reply-To header, oldest first, normalized. */
export function parseMessageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const re = /<([^<>\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const id = normalizeMessageId(m[1]);
    if (id && !out.includes(id)) out.push(id);
  }
  if (!out.length) {
    // Some senders omit angle brackets.
    for (const part of value.split(/\s+/)) {
      const id = normalizeMessageId(part);
      if (id && id.includes("@") && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Generates a new RFC 5322 Message-ID on the sending identity's domain. */
export function generateMessageId(fromEmail: string): string {
  const domain = normalizeEmail(fromEmail).split("@")[1] || "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Headers for a reply to `parent`: In-Reply-To = parent's Message-ID,
 * References = parent's References + parent's Message-ID (capped so the
 * header stays a sane length, keeping the root and the most recent ids,
 * as RFC 5322 §3.6.4 suggests).
 */
export function buildReplyHeaders(parent: { message_id_header: string | null; references_header: string | null; in_reply_to: string | null }): {
  inReplyTo: string | null;
  references: string | null;
} {
  const parentId = normalizeMessageId(parent.message_id_header);
  const refs = parseMessageIdList(parent.references_header);
  if (!refs.length) refs.push(...parseMessageIdList(parent.in_reply_to));
  if (parentId && !refs.includes(parentId)) refs.push(parentId);
  const capped = refs.length > 20 ? [refs[0]!, ...refs.slice(-19)] : refs;
  return {
    inReplyTo: parentId ? `<${parentId}>` : null,
    references: capped.length ? capped.map((r) => `<${r}>`).join(" ") : null,
  };
}

/** Candidate ids to look up when threading an incoming message (In-Reply-To first, then References newest-first). */
export function threadLookupIds(inReplyTo: string | null, references: string | null): string[] {
  const ids: string[] = [];
  for (const id of parseMessageIdList(inReplyTo)) if (!ids.includes(id)) ids.push(id);
  for (const id of parseMessageIdList(references).reverse()) if (!ids.includes(id)) ids.push(id);
  return ids.slice(0, 50);
}

export interface ReplySource {
  direction: "inbound" | "outbound";
  from: MailAddress;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
}

/**
 * Reply / Reply All recipient computation.
 *  - Reply: Reply-To if present, else the sender. Replying to your own
 *    sent message goes back to its original To recipients (what every
 *    mail client does).
 *  - Reply All: the reply target(s) + original To + original Cc, minus the
 *    sending identity (and every identity in `ownAddresses`), duplicates,
 *    and automated/list addresses (no-reply, mailer-daemon, *-request ...).
 *    The original sender is never dropped by the automated filter on To,
 *    since they're the person being replied to.
 */
export function computeReplyRecipients(
  source: ReplySource,
  mode: "reply" | "reply_all",
  sendingIdentity: string,
  ownAddresses: string[] = []
): { to: MailAddress[]; cc: MailAddress[] } {
  const self = new Set([sendingIdentity, ...ownAddresses].map(normalizeEmail));
  let primary: MailAddress[];
  if (source.direction === "outbound" || self.has(normalizeEmail(source.from.email))) {
    primary = source.to;
  } else {
    primary = source.replyTo.length ? source.replyTo : [source.from];
  }
  const to = dedupeAddresses(primary, self);
  if (mode === "reply") return { to, cc: [] };
  const extraTo = source.direction === "outbound" ? [] : source.to;
  const allTo = dedupeAddresses([...to, ...extraTo.filter((a) => !isAutomatedAddress(a.email))], self);
  const cc = dedupeAddresses(
    source.cc.filter((a) => !isAutomatedAddress(a.email)),
    [...self, ...allTo.map((a) => a.email)]
  );
  return { to: allTo, cc };
}
