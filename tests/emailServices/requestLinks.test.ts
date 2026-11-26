// Mailbox request links (CLAUDE.md §36): staff create/list/revoke, and the
// owner/admin gate on the two mutation routes. The public side that uses
// a link lives in altaventureswebsite and is verified there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { STAFF, seed } from "./helpers";
import { createRequestLink, listRequestLinks, revokeRequestLink, MAILBOX_REQUEST_BASE_URL } from "../../functions/_lib/emailServices/requestLinks";
import { requestMailboxByClient, transitionService } from "../../functions/_lib/emailServices/engine";
import { onRequestPost as createRoute, onRequestGet as listRoute } from "../../functions/api/app/email-services/[serviceId]/request-links/index";
import { onRequestPost as revokeRoute } from "../../functions/api/app/email-services/[serviceId]/request-links/[linkId]/revoke";
import type { StaffUser } from "../../functions/_lib/roles";

const owner: StaffUser = { id: "user_admin", email: "admin@altasme.com", full_name: "Admin", role: "owner" };
const sales: StaffUser = { id: "user_sales", email: "sales@altasme.com", full_name: "Sales", role: "sales" };

// Calls a Pages Function the way the runtime would, minus the middleware
// (which only attaches data.staffUser).
async function call(fn: PagesFunction<never, never, never>, db: unknown, params: Record<string, string>, staffUser: StaffUser) {
  const res = await (fn as unknown as (ctx: unknown) => Promise<Response>)({
    request: new Request("https://clientkeeper.altasme.com/x", { method: "POST", body: "{}" }),
    env: { DB: db },
    params,
    data: { staffUser },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("create: an open link with a unique slug, an access token, and the real www.altasme.com URL", async () => {
  const { db, serviceId } = await seed();
  const a = await createRequestLink(db, { serviceId, actor: STAFF });
  const b = await createRequestLink(db, { serviceId, actor: STAFF });
  assert.ok(a.ok && b.ok);
  const rows = db.raw.prepare(`SELECT * FROM mail_request_links WHERE service_id = ? ORDER BY created_at`).all(serviceId) as { slug: string; access_token: string; status: string; created_by: string }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.slug, "acme-ph");
  assert.equal(rows[1]!.slug, "acme-ph-2");
  assert.notEqual(rows[0]!.access_token, rows[1]!.access_token);
  assert.ok(rows.every((r) => r.status === "open" && r.created_by === "user_admin" && /^[a-z0-9]{8}$/.test(r.access_token)));
  assert.equal(a.value.link.url, `${MAILBOX_REQUEST_BASE_URL}/${rows[0]!.slug}?t=${rows[0]!.access_token}`);
  assert.ok(a.value.link.url.startsWith("https://www.altasme.com/mailbox-request/"));

  const audit = db.raw.prepare(`SELECT action, actor_type FROM email_audit_logs WHERE action = 'mailbox_request_link_created'`).all() as unknown[];
  assert.equal(audit.length, 2);
  assert.equal((await listRequestLinks(db, serviceId)).length, 2);
});

test("create: refused when the client couldn't use the link (no plan, no domain, not provisionable, unknown service)", async () => {
  const noPlan = await seed({ planId: null });
  const r1 = await createRequestLink(noPlan.db, { serviceId: noPlan.serviceId, actor: STAFF });
  assert.ok(!r1.ok);
  if (!r1.ok) assert.equal(r1.code, "no_plan");

  const noDomain = await seed({ domain: null });
  const r2 = await createRequestLink(noDomain.db, { serviceId: noDomain.serviceId, actor: STAFF });
  assert.ok(!r2.ok);
  if (!r2.ok) assert.equal(r2.code, "no_domain");

  const { db, serviceId } = await seed();
  db.raw.prepare(`UPDATE email_services SET status = 'suspended' WHERE id = ?`).run(serviceId);
  const r3 = await createRequestLink(db, { serviceId, actor: STAFF });
  assert.ok(!r3.ok);
  if (!r3.ok) assert.equal(r3.code, "service_not_provisionable");

  const r4 = await createRequestLink(db, { serviceId: "nope", actor: STAFF });
  assert.ok(!r4.ok);
  if (!r4.ok) assert.equal(r4.status, 404);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_request_links`).get() as { n: number }).n, 0);

  const client = await createRequestLink(db, { serviceId, actor: { type: "client", id: "client_1" } });
  assert.ok(!client.ok);
  if (!client.ok) assert.equal(client.code, "staff_only");
});

test("create: an expired service is refused even before anything rewrote its status", async () => {
  const { db, serviceId, domainId } = await seed();
  // Needs an active mailbox to activate; fulfil the requirement directly.
  assert.ok((await requestMailboxByClient(db, { serviceId, clientId: "client_1", domainId, localPart: "a", isPrimary: true, idempotencyKey: null })).ok);
  db.raw.prepare(`UPDATE email_mailboxes SET status = 'active', reserved_until = NULL WHERE service_id = ?`).run(serviceId);
  assert.ok((await transitionService(db, { serviceId, action: "activate", reason: null, expiresAt: null, actor: STAFF })).ok);
  db.raw.prepare(`UPDATE email_services SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(serviceId);
  const r = await createRequestLink(db, { serviceId, actor: STAFF });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.code, "service_not_provisionable");
});

test("revoke: open -> revoked once; a used link can't be revoked; another service's link is not found", async () => {
  const { db, serviceId } = await seed();
  const created = await createRequestLink(db, { serviceId, actor: STAFF });
  assert.ok(created.ok);
  const linkId = created.value.link.id;

  const r = await revokeRequestLink(db, { serviceId, linkId, actor: STAFF });
  assert.ok(r.ok);
  assert.equal(r.value.link.status, "revoked");
  const again = await revokeRequestLink(db, { serviceId, linkId, actor: STAFF });
  assert.ok(!again.ok);
  if (!again.ok) assert.equal(again.code, "link_revoked");

  const other = await seed();
  const wrongService = await revokeRequestLink(db, { serviceId: other.serviceId, linkId, actor: STAFF });
  assert.ok(!wrongService.ok);
  if (!wrongService.ok) assert.equal(wrongService.status, 404);

  // What the public route does on a successful submission.
  const used = await createRequestLink(db, { serviceId, actor: STAFF });
  assert.ok(used.ok);
  db.raw.prepare(`UPDATE mail_request_links SET status = 'used', used_at = ? WHERE id = ?`).run(new Date().toISOString(), used.value.link.id);
  const refused = await revokeRequestLink(db, { serviceId, linkId: used.value.link.id, actor: STAFF });
  assert.ok(!refused.ok);
  if (!refused.ok) assert.equal(refused.code, "link_used");
  assert.equal((db.raw.prepare(`SELECT status FROM mail_request_links WHERE id = ?`).get(used.value.link.id) as { status: string }).status, "used");

  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_audit_logs WHERE action = 'mailbox_request_link_revoked'`).get() as { n: number }).n, 1);
});

test("list: a used link shows the address of the request it created", async () => {
  const { db, serviceId, domainId } = await seed();
  const created = await createRequestLink(db, { serviceId, actor: STAFF });
  assert.ok(created.ok);
  const req = await requestMailboxByClient(db, { serviceId, clientId: "client_1", domainId, localPart: "hello", isPrimary: false, idempotencyKey: null });
  assert.ok(req.ok);
  db.raw.prepare(`UPDATE mail_request_links SET status = 'used', used_at = ?, used_mailbox_id = ? WHERE id = ?`).run(new Date().toISOString(), req.value.mailbox.id, created.value.link.id);
  const [link] = await listRequestLinks(db, serviceId);
  assert.equal(link!.status, "used");
  assert.equal(link!.usedMailboxAddress, "hello@acme.ph");
  assert.equal(link!.createdBy, "Admin");
});

test("routes: create and revoke are owner/admin only; listing is open to any staff role", async () => {
  const { db, serviceId } = await seed();
  db.raw.prepare(`INSERT INTO users (id, email, full_name, role, created_at) VALUES ('user_sales', 'sales@altasme.com', 'Sales', 'sales', ?)`).run(new Date().toISOString());

  const denied = await call(createRoute as never, db, { serviceId }, sales);
  assert.equal(denied.status, 403);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_request_links`).get() as { n: number }).n, 0);

  const ok = await call(createRoute as never, db, { serviceId }, owner);
  assert.equal(ok.status, 201);
  const link = ok.body.link as { id: string; url: string; status: string };
  assert.equal(link.status, "open");
  assert.match(link.url, /^https:\/\/www\.altasme\.com\/mailbox-request\/acme-ph\?t=[a-z0-9]{8}$/);

  const listed = await call(listRoute as never, db, { serviceId }, sales);
  assert.equal(listed.status, 200);
  assert.equal((listed.body.links as unknown[]).length, 1);

  const revokeDenied = await call(revokeRoute as never, db, { serviceId, linkId: link.id }, sales);
  assert.equal(revokeDenied.status, 403);
  const revoked = await call(revokeRoute as never, db, { serviceId, linkId: link.id }, owner);
  assert.equal(revoked.status, 200);
  const twice = await call(revokeRoute as never, db, { serviceId, linkId: link.id }, owner);
  assert.equal(twice.status, 409);
});
