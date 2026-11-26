// Inbound poll sync for Z.com-hosted client mailboxes (CLAUDE.md §35).
//
// Z.com has no new-mail push, so mail for a bridged client mailbox
// (email_mailboxes.inbound_source = 'zcom_poll_sync', active, linked to a
// mail_accounts row) is pulled through the provider's read-only message
// API on the mail worker's cron and stored exactly like Cloudflare Email
// Routing mail: each message is handed to @altasme/webmail-kit's own
// processInbound(), which does the R2 raw copy, parsing, dedupe,
// threading, attachments, the D1 batch and the failure record. Nothing
// here re-derives that insert logic, and the package itself is unchanged.
//
// TODAY THIS NEVER RUNS: the only provider is the NotConfiguredProvider
// placeholder, and the sync is skipped entirely while
// provider.status().configured is false (logging one console line, not
// one provisioning-log row per mailbox per minute). It starts working,
// unchanged, once a real Z.com adapter is returned by getEmailProvider().
//
// Bounded per cron tick, because Workers cap CPU time and subrequests per
// invocation: at most BATCH_SIZE mailboxes, one list call each, and at
// most MAX_NEW_PER_MAILBOX new messages fetched per mailbox. Anything
// left over is picked up on a later tick.
//
// Idempotency. Z.com's List Messages has no "since" filter, so every pass
// re-lists the most recent LIST_LIMIT messages. To avoid re-fetching (and
// re-uploading to R2) messages already stored, each stored message gets a
// mail_events row (event_type 'zcom_poll_synced', event_data holding the
// provider's message id); a listed id with such a row is skipped without
// any further provider call. If that marker is missing for any reason,
// processInbound's own UNIQUE(account_id, dedupe_key) handling still
// recognizes the message as a duplicate. No schema change is needed.
//
// Known limitation: if more than LIST_LIMIT messages arrive for one
// mailbox between two passes of it, the older ones fall off the first
// page and are not fetched (no paging past page one, no "since" filter).
//
// Per-mailbox isolation: any failure (provider error, parse error, D1
// error) is caught, logged to email_provisioning_logs for that mailbox,
// and the batch moves on to the next mailbox.

import { buildMimeMessage, type MimeAttachment } from "@altasme/webmail-kit/mime";
import { parseAddress, parseAddressList } from "@altasme/webmail-kit/address";
import { processInbound, InboundProcessingError, type WorkerEnv } from "@altasme/webmail-kit/worker/inbound";
import { provisioningLogStatement, type Actor } from "../../functions/_lib/emailServices/logs";
import { callProvider, type EmailHostingProvider, type ProviderError, type ProviderMessageDetails } from "../../functions/_lib/emailServices/provider";

export const BATCH_SIZE = 5;
export const LIST_LIMIT = 50;
export const MAX_NEW_PER_MAILBOX = 10;
// A mailbox is not polled again until this long after its last attempt.
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const SYNCED_EVENT = "zcom_poll_synced";

const SYSTEM: Actor = { type: "system", id: null };

interface Candidate {
  id: string;
  service_id: string;
  address: string;
  provider_mailbox_id: string;
  provider_service_id: string | null;
  account_id: string;
  account_address: string;
  provider: string;
}

export interface MailboxSyncSummary {
  mailboxId: string;
  listed: number;
  skippedKnown: number;
  stored: number;
  duplicates: number;
  inboundFailures: number;
  providerErrors: number;
  deferred: number;
  ok: boolean;
}

export interface PollSyncSummary {
  skipped: "provider_not_configured" | null;
  mailboxes: MailboxSyncSummary[];
}

const internalError = (message: string): ProviderError => ({ code: "provider_error", message: message.slice(0, 300), outcome: "not_performed", retryable: true });

// Oldest last ATTEMPT first, from the message_sync log, not last_synced_at
// (which only moves on success): a mailbox whose sync keeps failing must
// not sit at the front of the queue forever and starve the others.
async function selectCandidates(db: D1Database, now: string): Promise<Candidate[]> {
  const cutoff = new Date(Date.parse(now) - MIN_POLL_INTERVAL_MS).toISOString();
  const rows = await db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.service_id, m.address, m.provider_mailbox_id, COALESCE(m.provider_service_id, s.provider_service_id) AS provider_service_id,
                a.id AS account_id, a.email_address AS account_address, s.provider,
                (SELECT MAX(l.created_at) FROM email_provisioning_logs l WHERE l.service_id = m.service_id AND l.mailbox_id = m.id AND l.operation = 'message_sync') AS last_attempt
         FROM email_mailboxes m
         JOIN email_services s ON s.id = m.service_id
         JOIN mail_accounts a ON a.id = m.mail_account_id AND a.is_active = 1 AND a.inbound_enabled = 1
         WHERE m.inbound_source = 'zcom_poll_sync' AND m.status = 'active' AND m.mail_account_id IS NOT NULL
           AND m.provider_mailbox_id IS NOT NULL AND s.status <> 'cancelled'
       )
       WHERE last_attempt IS NULL OR last_attempt <= ?
       ORDER BY last_attempt ASC NULLS FIRST
       LIMIT ?`
    )
    .bind(cutoff, BATCH_SIZE)
    .all<Candidate>();
  return rows.results;
}

async function alreadySynced(db: D1Database, accountId: string, providerMessageId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM mail_events WHERE account_id = ? AND event_type = ? AND json_extract(event_data, '$.providerMessageId') = ? LIMIT 1`)
    .bind(accountId, SYNCED_EVENT, providerMessageId)
    .first<{ hit: number }>();
  return !!row;
}

function markSynced(db: D1Database, accountId: string, messageId: string | null, providerMessageId: string, outcome: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO mail_events (id, account_id, message_id, event_type, event_data, actor_id, created_at) VALUES (?, ?, ?, ?, ?, 'mail-worker', ?)`)
    .bind(crypto.randomUUID(), accountId, messageId, SYNCED_EVENT, JSON.stringify({ providerMessageId, outcome }), new Date().toISOString());
}

// Rebuilds a MIME message when the adapter couldn't give raw MIME (see
// ProviderMessageDetails.rawMime). The Message-ID is derived from the
// provider's id so re-processing the same message yields the same dedupe
// key. Attachments are only fetched when the provider says there are any.
async function synthesizeMime(provider: EmailHostingProvider, c: Candidate, d: ProviderMessageDetails): Promise<{ mime: string } | { error: ProviderError }> {
  const attachments: MimeAttachment[] = [];
  if (d.hasAttachments) {
    for (const a of d.attachments) {
      const { result } = await callProvider(() =>
        provider.getAttachment({ providerServiceId: c.provider_service_id, providerMailboxId: c.provider_mailbox_id, providerMessageId: d.providerMessageId, attachmentId: a.attachmentId })
      );
      if (!result.ok) return { error: result.error };
      attachments.push({ filename: result.value.filename || a.filename, mimeType: result.value.contentType || a.contentType, content: new Uint8Array(result.value.data) });
    }
  }
  const domain = c.account_address.split("@")[1] ?? "zcom.invalid";
  const safeId = d.providerMessageId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  const parsedDate = Date.parse(d.date);
  const mime = buildMimeMessage({
    from: parseAddress(d.from) ?? { name: null, email: "unknown-sender@invalid.invalid" },
    to: d.to.flatMap((t) => parseAddressList(t).valid),
    cc: d.cc.flatMap((t) => parseAddressList(t).valid),
    subject: d.subject.replace(/[\r\n]+/g, " "),
    text: d.bodyText ?? "",
    html: d.bodyHtml ?? "",
    messageId: `<zcom-${safeId}@${domain}>`,
    date: Number.isNaN(parsedDate) ? undefined : new Date(parsedDate),
    attachments,
  });
  return { mime };
}

async function syncMailbox(env: WorkerEnv, provider: EmailHostingProvider, c: Candidate): Promise<{ summary: MailboxSyncSummary; error: ProviderError | null; durationMs: number }> {
  const db = env.DB!;
  const summary: MailboxSyncSummary = { mailboxId: c.id, listed: 0, skippedKnown: 0, stored: 0, duplicates: 0, inboundFailures: 0, providerErrors: 0, deferred: 0, ok: false };
  let firstError: ProviderError | null = null;
  let durationMs = 0;

  const listed = await callProvider(() =>
    provider.listMessages({ providerServiceId: c.provider_service_id, providerMailboxId: c.provider_mailbox_id, sortKey: "date", sortType: "desc", limit: LIST_LIMIT, offset: 0 })
  );
  durationMs += listed.durationMs;
  if (!listed.result.ok) {
    summary.providerErrors++;
    return { summary, error: listed.result.error, durationMs };
  }
  summary.listed = listed.result.value.length;

  // Oldest first, so a mailbox catching up stores mail in arrival order.
  const fresh = [];
  for (const m of [...listed.result.value].reverse()) {
    if (await alreadySynced(db, c.account_id, m.providerMessageId)) summary.skippedKnown++;
    else fresh.push(m);
  }
  summary.deferred = Math.max(0, fresh.length - MAX_NEW_PER_MAILBOX);

  for (const m of fresh.slice(0, MAX_NEW_PER_MAILBOX)) {
    const details = await callProvider(() => provider.getMessageDetails({ providerServiceId: c.provider_service_id, providerMailboxId: c.provider_mailbox_id, providerMessageId: m.providerMessageId }));
    durationMs += details.durationMs;
    if (!details.result.ok) {
      summary.providerErrors++;
      firstError ??= details.result.error;
      continue; // not marked: retried on the next pass
    }
    const d = details.result.value;
    let raw: string;
    if (d.rawMime !== null) {
      raw = d.rawMime;
    } else {
      const built = await synthesizeMime(provider, c, d);
      if ("error" in built) {
        summary.providerErrors++;
        firstError ??= built.error;
        continue;
      }
      raw = built.mime;
    }

    try {
      const outcome = await processInbound(env, { raw: new TextEncoder().encode(raw), envelopeFrom: d.from, envelopeTo: c.account_address });
      if (outcome.status === "stored") {
        summary.stored++;
        await markSynced(db, c.account_id, outcome.messageId, m.providerMessageId, "stored").run();
      } else if (outcome.status === "duplicate") {
        summary.duplicates++;
        await markSynced(db, c.account_id, outcome.existingId, m.providerMessageId, "duplicate").run();
      } else {
        // The account was disabled between selection and now.
        summary.inboundFailures++;
        firstError ??= internalError(`Inbound refused: ${outcome.reason}`);
      }
    } catch (err) {
      if (err instanceof InboundProcessingError) {
        // processInbound already kept the raw copy in R2 and recorded it in
        // mail_inbound_failures for a human. Mark it so it isn't re-fetched
        // (and re-recorded) on every pass.
        summary.inboundFailures++;
        await markSynced(db, c.account_id, null, m.providerMessageId, "inbound_failed").run();
      } else {
        throw err;
      }
    }
  }

  summary.ok = summary.providerErrors === 0 && !firstError;
  return { summary, error: firstError, durationMs };
}

export async function runZcomPollSync(env: WorkerEnv, provider: EmailHostingProvider, now = new Date().toISOString()): Promise<PollSyncSummary> {
  const db = env.DB;
  if (!db) throw new Error("DB binding missing");
  if (!provider.status().configured) return { skipped: "provider_not_configured", mailboxes: [] };

  const candidates = await selectCandidates(db, now);
  const out: MailboxSyncSummary[] = [];
  for (const c of candidates) {
    let summary: MailboxSyncSummary;
    let error: ProviderError | null;
    let durationMs = 0;
    try {
      ({ summary, error, durationMs } = await syncMailbox(env, provider, c));
    } catch (err) {
      summary = { mailboxId: c.id, listed: 0, skippedKnown: 0, stored: 0, duplicates: 0, inboundFailures: 0, providerErrors: 0, deferred: 0, ok: false };
      error = internalError(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const done = new Date().toISOString();
    const statements = [
      provisioningLogStatement(db, { serviceId: c.service_id, mailboxId: c.id, provider: c.provider, operation: "message_sync", error, durationMs, details: summary, actor: SYSTEM, now: done }),
    ];
    if (summary.ok) statements.push(db.prepare(`UPDATE email_mailboxes SET last_synced_at = ? WHERE id = ?`).bind(done, c.id));
    try {
      await db.batch(statements);
    } catch (err) {
      console.error("zcom poll sync: could not record outcome", err instanceof Error ? err.message : err);
    }
    out.push(summary);
  }
  return { skipped: null, mailboxes: out };
}
