// Mailbox request links (CLAUDE.md §36): one-time, token-gated links that
// let a client ask for a mailbox without logging in anywhere. Staff create
// one per email service here and send it by hand; the client opens it on
// the marketing site (www.altasme.com/mailbox-request/:slug?t=...), whose
// own Pages Function does the reservation. That function is a separate
// deployable and carries its own copy of requestMailboxByClient's INSERT
// (see altaventureswebsite's functions/api/public/mailbox-request/), with
// the link's service_id in place of a client session as the ownership
// boundary. Nothing here reserves a slot.
//
// A link carries no domain: the client picks among the service's active
// domains on the public page, so one link stays useful if staff add a
// second domain after sending it.

import { auditStatement, type Actor } from "./logs";
import { canProvisionMailbox, effectiveServiceStatus } from "./policy";
import { loadService, type EngineResult } from "./engine";
import { generateUniqueSlugAndToken } from "../publicDocs";

// The marketing site's real public host (altaventureswebsite CLAUDE.md
// §41: www, never the bare apex, which doesn't serve the site).
export const MAILBOX_REQUEST_BASE_URL = "https://www.altasme.com/mailbox-request";

export type RequestLinkStatus = "open" | "used" | "revoked";

export interface RequestLinkRow {
  id: string;
  service_id: string;
  slug: string;
  access_token: string;
  status: RequestLinkStatus;
  created_by: string | null;
  used_at: string | null;
  used_mailbox_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestLinkView {
  id: string;
  status: RequestLinkStatus;
  url: string;
  createdBy: string | null;
  createdAt: string;
  usedAt: string | null;
  usedMailboxId: string | null;
  usedMailboxAddress: string | null;
}

function fail(status: number, code: string, error: string): { ok: false; status: number; error: string; code: string } {
  return { ok: false, status, code, error };
}

export function requestLinkUrl(row: Pick<RequestLinkRow, "slug" | "access_token">): string {
  return `${MAILBOX_REQUEST_BASE_URL}/${row.slug}?t=${row.access_token}`;
}

export async function listRequestLinks(db: D1Database, serviceId: string): Promise<RequestLinkView[]> {
  const res = await db
    .prepare(
      `SELECT l.*, u.full_name AS creator_name, m.address AS used_mailbox_address
       FROM mail_request_links l
       LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN email_mailboxes m ON m.id = l.used_mailbox_id
       WHERE l.service_id = ? ORDER BY l.created_at DESC`
    )
    .bind(serviceId)
    .all<RequestLinkRow & { creator_name: string | null; used_mailbox_address: string | null }>();
  return res.results.map((r) => ({
    id: r.id,
    status: r.status,
    url: requestLinkUrl(r),
    createdBy: r.creator_name ?? r.created_by,
    createdAt: r.created_at,
    usedAt: r.used_at,
    usedMailboxId: r.used_mailbox_id,
    usedMailboxAddress: r.used_mailbox_address,
  }));
}

// Refuses to mint a link the client couldn't use (no plan, no domain,
// service not in a provisionable state), so staff find out now rather
// than the client finding out on submit. The public route re-checks all
// of it atomically anyway: a link minted for a usable service can still
// be refused later if the service is suspended in the meantime.
export async function createRequestLink(db: D1Database, input: { serviceId: string; actor: Actor; now?: string }): Promise<EngineResult<{ link: RequestLinkView }>> {
  const now = input.now ?? new Date().toISOString();
  if (input.actor.type !== "staff" || !input.actor.id) return fail(403, "staff_only", "Only staff can create a mailbox request link.");
  const service = await loadService(db, input.serviceId);
  if (!service) return fail(404, "service_not_found", "Email service not found.");
  if (!canProvisionMailbox(service.status, service.expires_at, now)) {
    return fail(409, "service_not_provisionable", `Mailboxes can't be requested while the service is ${effectiveServiceStatus(service.status, service.expires_at, now).replace("_", " ")}.`);
  }
  if (!service.plan_id) return fail(409, "no_plan", "Assign a plan before sending a mailbox request link.");
  const domain = await db.prepare(`SELECT id FROM email_domains WHERE service_id = ? AND status = 'active' LIMIT 1`).bind(input.serviceId).first<{ id: string }>();
  if (!domain) return fail(409, "no_domain", "Assign a domain before sending a mailbox request link.");

  const client = await db.prepare(`SELECT business_name FROM clients WHERE id = ?`).bind(service.client_id).first<{ business_name: string }>();
  const { slug, accessToken } = await generateUniqueSlugAndToken(db, "mail_request_links", client?.business_name ?? "mailbox");
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(`INSERT INTO mail_request_links (id, service_id, slug, access_token, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`)
      .bind(id, input.serviceId, slug, accessToken, input.actor.id, now, now),
    auditStatement(db, { serviceId: input.serviceId, actor: input.actor, action: "mailbox_request_link_created", after: { linkId: id, slug }, now }),
  ]);
  const link = (await listRequestLinks(db, input.serviceId)).find((l) => l.id === id)!;
  return { ok: true, value: { link } };
}

// open -> revoked. One conditional UPDATE, so a revoke racing a client's
// submission resolves cleanly: whichever commits first wins, and a used
// link is never flipped to revoked (the request it made stands; decline
// that instead).
export async function revokeRequestLink(db: D1Database, input: { serviceId: string; linkId: string; actor: Actor; now?: string }): Promise<EngineResult<{ link: RequestLinkView }>> {
  const now = input.now ?? new Date().toISOString();
  if (input.actor.type !== "staff" || !input.actor.id) return fail(403, "staff_only", "Only staff can revoke a mailbox request link.");
  const res = await db
    .prepare(`UPDATE mail_request_links SET status = 'revoked', updated_at = ? WHERE id = ? AND service_id = ? AND status = 'open'`)
    .bind(now, input.linkId, input.serviceId)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const existing = await db.prepare(`SELECT status FROM mail_request_links WHERE id = ? AND service_id = ?`).bind(input.linkId, input.serviceId).first<{ status: RequestLinkStatus }>();
    if (!existing) return fail(404, "link_not_found", "Request link not found.");
    if (existing.status === "used") return fail(409, "link_used", "This link was already used. Decline the request it created instead.");
    return fail(409, "link_revoked", "This link is already revoked.");
  }
  await db.batch([auditStatement(db, { serviceId: input.serviceId, actor: input.actor, action: "mailbox_request_link_revoked", after: { linkId: input.linkId }, now })]);
  const link = (await listRequestLinks(db, input.serviceId)).find((l) => l.id === input.linkId)!;
  return { ok: true, value: { link } };
}
