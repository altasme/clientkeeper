// Manual fulfillment (CLAUDE.md §35): client requests, staff fulfillment
// with the webmail bridge, and declines. No provider is involved anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { STAFF, seed, serviceRow } from "./helpers";
import {
  adjustEntitlement,
  declineMailboxRequest,
  fulfillMailboxManually,
  getAllowance,
  provisionMailbox,
  requestMailboxByClient,
  sweepStaleMailboxes,
  transitionService,
} from "../../functions/_lib/emailServices/engine";
import { createService } from "../../functions/_lib/emailServices/services";
import { NotConfiguredProvider } from "../../functions/_lib/emailServices/provider/notConfigured";

const CLIENT = "client_1";

const request = (db: Parameters<typeof requestMailboxByClient>[0], serviceId: string, domainId: string, localPart: string, extra: Partial<Parameters<typeof requestMailboxByClient>[1]> = {}) =>
  requestMailboxByClient(db, { serviceId, clientId: CLIENT, domainId, localPart, isPrimary: false, idempotencyKey: null, ...extra });

const fulfill = (db: Parameters<typeof fulfillMailboxManually>[0], serviceId: string, mailboxId: string, extra: Partial<Parameters<typeof fulfillMailboxManually>[1]> = {}) =>
  fulfillMailboxManually(db, { serviceId, mailboxId, providerMailboxId: "zmail-77", providerServiceId: "zsvc-9", smtpProfileKey: "client-acme-sales", createBridgeAccount: true, actor: STAFF, ...extra });

test("client request: reserved with no lease, held indefinitely, never swept, counted against the allowance", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "team" }); // 3 included
  const r = await request(db, serviceId, domainId, "Sales");
  assert.ok(r.ok);
  const m = r.value.mailbox;
  assert.equal(m.status, "reserved");
  assert.equal(m.reserved_until, null);
  assert.equal(m.address, "sales@acme.ph");
  assert.equal(m.created_by, CLIENT);
  assert.equal(m.created_by_type, "client");
  assert.equal(m.inbound_source, "zcom_poll_sync");

  // Far in the future: the lease sweep must leave it alone.
  const later = new Date(Date.now() + 365 * 86400_000).toISOString();
  assert.equal(await sweepStaleMailboxes(db, serviceId, later), 0);
  const a = (await getAllowance(db, serviceId, later))!;
  assert.deepEqual([a.total, a.active, a.pending, a.available], [3, 0, 1, 2]);

  const audit = db.raw.prepare(`SELECT actor_type, actor_id, action FROM email_audit_logs WHERE mailbox_id = ?`).get(m.id) as Record<string, string>;
  assert.deepEqual({ ...audit }, { actor_type: "client", actor_id: CLIENT, action: "mailbox_requested_by_client" });
  // No provider call means no provisioning log at all.
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_provisioning_logs`).get() as { n: number }).n, 0);
});

test("client request: a client cannot reserve against a service that isn't theirs", async () => {
  const { db, serviceId, domainId } = await seed();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO clients (id, email, full_name, business_name, created_at, updated_at) VALUES ('client_2', 'x@other.ph', 'Other', 'Other Co', ?, ?)`).run(now, now);
  const r = await requestMailboxByClient(db, { serviceId, clientId: "client_2", domainId, localPart: "intruder", isPrimary: false, idempotencyKey: null });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.code, "service_not_found");
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_mailboxes`).get() as { n: number }).n, 0);

  // Nor with another service's domain: domain must belong to the service.
  const other = await createService(db, { clientId: "client_2", planId: "team", domain: "other.ph", internalNotes: null, providerServiceId: null, actor: STAFF });
  assert.ok(other.ok);
  const r2 = await requestMailboxByClient(db, { serviceId: other.value.serviceId, clientId: "client_2", domainId, localPart: "x", isPrimary: false, idempotencyKey: null });
  assert.ok(!r2.ok);
  if (!r2.ok) assert.equal(r2.code, "domain_not_found");
});

test("client request: the ownership check lives in the INSERT itself, not just the lookup", async () => {
  // Move the service to another client at the last moment, right before
  // the reservation INSERT runs (after the ownership lookup passed).
  const { db, serviceId, domainId } = await seed();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO clients (id, email, full_name, business_name, created_at, updated_at) VALUES ('client_2', 'x@other.ph', 'Other', 'Other Co', ?, ?)`).run(now, now);
  const realPrepare = db.prepare.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = (sql: string) => {
    if (/^\s*INSERT INTO email_mailboxes/.test(sql)) db.raw.prepare(`UPDATE email_services SET client_id = 'client_2' WHERE id = ?`).run(serviceId);
    return realPrepare(sql);
  };
  const r = await request(db, serviceId, domainId, "racer");
  assert.ok(!r.ok, "a service that changed hands mid-request must not get a row");
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_mailboxes`).get() as { n: number }).n, 0);
});

test("client request concurrency: simultaneous requests yield exactly one pending request, and capacity holds", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" }); // 1 slot
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => request(db, serviceId, domainId, `user${i}`)));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1);
  for (const r of results) if (!r.ok) assert.ok(["request_pending", "allowance_exhausted"].includes(r.code), r.code);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_mailboxes`).get() as { n: number }).n, 1);

  // With room for many but the one-pending rule: still exactly one.
  const s2 = await seed({ planId: "growth" });
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => request(s2.db, s2.serviceId, s2.domainId, `u${i}`)));
  assert.equal(many.filter((r) => r.ok).length, 1);
  for (const r of many) if (!r.ok) assert.equal(r.code, "request_pending");
});

test("client request: a held request counts, so the allowance can't be dropped below it", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "team" }); // 3
  assert.ok((await request(db, serviceId, domainId, "client-asked")).ok);
  assert.equal((await getAllowance(db, serviceId))!.available, 2);
  const drop = await adjustEntitlement(db, { serviceId, kind: "override", quantity: -3, reason: "test", actor: STAFF });
  assert.ok(!drop.ok, "can't drop the allowance below the held request");
  if (!drop.ok) assert.equal(drop.code, "below_usage");
});

test("client request: refused while suspended, without a plan, or with no slot; idempotent repeat returns the same row", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" });
  const key = "client-req-123456";
  const first = await request(db, serviceId, domainId, "one", { idempotencyKey: key });
  const again = await request(db, serviceId, domainId, "one", { idempotencyKey: key });
  assert.ok(first.ok && again.ok);
  assert.equal(again.value.duplicateRequest, true);
  assert.equal(again.value.mailbox.id, first.value.mailbox.id);

  // Decline it so the pending rule isn't what refuses the next ones.
  assert.ok((await declineMailboxRequest(db, { serviceId, mailboxId: first.value.mailbox.id, reason: "test", actor: STAFF })).ok);

  const noPlan = await seed({ planId: null });
  const r1 = await request(noPlan.db, noPlan.serviceId, noPlan.domainId, "x");
  assert.ok(!r1.ok);
  if (!r1.ok) assert.equal(r1.code, "no_plan");

  db.raw.prepare(`UPDATE email_services SET status = 'suspended' WHERE id = ?`).run(serviceId);
  const r2 = await request(db, serviceId, domainId, "two");
  assert.ok(!r2.ok);
  if (!r2.ok) assert.equal(r2.code, "service_not_provisionable");

  const bad = await request(db, serviceId, domainId, "bad name!");
  assert.ok(!bad.ok);
  if (!bad.ok) assert.equal(bad.code, "invalid_local_part");
});

test("decline frees the slot and the address for a new request", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" });
  const r = await request(db, serviceId, domainId, "info");
  assert.ok(r.ok);
  assert.equal((await getAllowance(db, serviceId))!.available, 0);

  const noReason = await declineMailboxRequest(db, { serviceId, mailboxId: r.value.mailbox.id, reason: "  ", actor: STAFF });
  assert.ok(!noReason.ok);
  const asClient = await declineMailboxRequest(db, { serviceId, mailboxId: r.value.mailbox.id, reason: "x", actor: { type: "client", id: CLIENT } });
  assert.ok(!asClient.ok);
  if (!asClient.ok) assert.equal(asClient.status, 403);

  const d = await declineMailboxRequest(db, { serviceId, mailboxId: r.value.mailbox.id, reason: "Name reserved for the owner", actor: STAFF });
  assert.ok(d.ok);
  assert.equal(d.value.mailbox.status, "discarded");
  assert.equal(d.value.mailbox.failure_code, "declined_by_staff");
  assert.equal(d.value.mailbox.last_error, "Name reserved for the owner");
  assert.equal((await getAllowance(db, serviceId))!.available, 1);

  const again = await request(db, serviceId, domainId, "info");
  assert.ok(again.ok, "the same address is requestable again at once");

  // Only client requests can be declined.
  const staffReserved = await seed();
  const prov = await provisionMailbox(staffReserved.db, new NotConfiguredProvider("zcom"), { serviceId: staffReserved.serviceId, domainId: staffReserved.domainId, localPart: "s", password: "Passw0rdPassw0rd", isPrimary: false, idempotencyKey: null, actor: STAFF });
  assert.ok(prov.ok);
  const nope = await declineMailboxRequest(staffReserved.db, { serviceId: staffReserved.serviceId, mailboxId: prov.value.mailbox.id, reason: "x", actor: STAFF });
  assert.ok(!nope.ok);
  if (!nope.ok) assert.equal(nope.code, "not_a_pending_request");
});

test("fulfill: client request -> active with staff-entered ids, a bridge account and access grant; no password anywhere", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "team" });
  db.raw.prepare(`UPDATE email_services SET provider_service_id = 'zsvc-service' WHERE id = ?`).run(serviceId);
  const r = await request(db, serviceId, domainId, "sales", { isPrimary: true });
  assert.ok(r.ok);

  const asClient = await fulfill(db, serviceId, r.value.mailbox.id, { actor: { type: "client", id: CLIENT } });
  assert.ok(!asClient.ok);
  if (!asClient.ok) assert.equal(asClient.status, 403);

  const f = await fulfill(db, serviceId, r.value.mailbox.id, { providerServiceId: null });
  assert.ok(f.ok);
  const m = f.value.mailbox;
  assert.equal(m.status, "active");
  assert.equal(m.provider_mailbox_id, "zmail-77");
  assert.equal(m.provider_service_id, "zsvc-service", "falls back to the service's own provider id");
  assert.equal(m.reserved_until, null);
  assert.ok(m.provisioned_at);
  assert.ok(f.value.mailAccountId);
  assert.equal(m.mail_account_id, f.value.mailAccountId);
  assert.equal(f.value.smtpProfile, "client-acme-sales");

  const account = db.raw.prepare(`SELECT * FROM mail_accounts WHERE id = ?`).get(f.value.mailAccountId) as Record<string, unknown>;
  assert.equal(account.email_address, "sales@acme.ph");
  assert.equal(account.display_name, "Acme PH");
  assert.equal(account.smtp_profile, "client-acme-sales");
  assert.deepEqual([account.inbound_enabled, account.outbound_enabled, account.is_active], [1, 1, 1]);
  const access = db.raw.prepare(`SELECT user_id, can_send, granted_by FROM mail_account_access WHERE account_id = ?`).all(f.value.mailAccountId) as Record<string, unknown>[];
  assert.deepEqual(access.map((a) => ({ ...a })), [{ user_id: "user_admin", can_send: 1, granted_by: "user_admin" }]);

  const log = db.raw.prepare(`SELECT operation, outcome, actor_type FROM email_provisioning_logs WHERE mailbox_id = ?`).get(m.id) as Record<string, string>;
  assert.deepEqual({ ...log }, { operation: "manual_fulfillment", outcome: "succeeded", actor_type: "staff" });
  assert.ok(db.raw.prepare(`SELECT 1 FROM email_audit_logs WHERE action = 'mailbox_fulfilled_manually' AND mailbox_id = ?`).get(m.id));

  // Nothing resembling a password in any row of any table this touched.
  const tables = ["email_mailboxes", "mail_accounts", "mail_account_access", "email_provisioning_logs", "email_audit_logs", "client_activity"];
  for (const t of tables) {
    const cols = (db.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.some((c) => /pass|secret|token/i.test(c)), `${t} must have no credential column`);
    const dump = JSON.stringify(db.raw.prepare(`SELECT * FROM ${t}`).all());
    assert.ok(!/password|passwd|secret/i.test(dump), `${t} must contain nothing resembling a password`);
  }
});

test("fulfill twice is rejected and writes nothing; simultaneous fulfills have exactly one winner", async () => {
  const { db, serviceId, domainId } = await seed();
  const r = await request(db, serviceId, domainId, "billing");
  assert.ok(r.ok);
  const [a, b] = await Promise.all([fulfill(db, serviceId, r.value.mailbox.id), fulfill(db, serviceId, r.value.mailbox.id, { providerMailboxId: "zmail-other" })]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  const loser = [a, b].find((x) => !x.ok)!;
  if (!loser.ok) assert.equal(loser.code, "already_fulfilled");

  const third = await fulfill(db, serviceId, r.value.mailbox.id);
  assert.ok(!third.ok);
  if (!third.ok) assert.equal(third.code, "already_fulfilled");
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_accounts`).get() as { n: number }).n, 1);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_provisioning_logs WHERE operation = 'manual_fulfillment'`).get() as { n: number }).n, 1);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM email_audit_logs WHERE action = 'mailbox_fulfilled_manually'`).get() as { n: number }).n, 1);
});

test("fulfill reuses an existing mail_accounts row for the address and keeps its smtp profile", async () => {
  const { db, serviceId, domainId } = await seed();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO mail_accounts (id, email_address, display_name, smtp_profile, created_at, updated_at) VALUES ('acct_old', 'help@acme.ph', 'Old', 'existing-key', ?, ?)`).run(now, now);
  const r = await request(db, serviceId, domainId, "help");
  assert.ok(r.ok);
  const f = await fulfill(db, serviceId, r.value.mailbox.id, { smtpProfileKey: "new-key" });
  assert.ok(f.ok);
  assert.equal(f.value.mailAccountId, "acct_old");
  assert.equal(f.value.smtpProfile, "existing-key");
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_accounts`).get() as { n: number }).n, 1);
});

test("fulfill without a bridge account; validation of ids and keys", async () => {
  const { db, serviceId, domainId } = await seed();
  const r = await request(db, serviceId, domainId, "nobridge");
  assert.ok(r.ok);
  const badKey = await fulfill(db, serviceId, r.value.mailbox.id, { smtpProfileKey: "has spaces!" });
  assert.ok(!badKey.ok);
  const noId = await fulfill(db, serviceId, r.value.mailbox.id, { providerMailboxId: "  " });
  assert.ok(!noId.ok);
  const f = await fulfill(db, serviceId, r.value.mailbox.id, { createBridgeAccount: false, smtpProfileKey: null });
  assert.ok(f.ok);
  assert.equal(f.value.mailAccountId, null);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_accounts`).get() as { n: number }).n, 0);
});

test("fulfill recovers a failed staff attempt (capacity re-checked) and clears provisioning_error", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" });
  const prov = await provisionMailbox(db, new NotConfiguredProvider("zcom"), { serviceId, domainId, localPart: "owner", password: "Passw0rdPassw0rd", isPrimary: true, idempotencyKey: null, actor: STAFF });
  assert.ok(prov.ok);
  assert.equal(prov.value.mailbox.status, "failed");
  assert.equal(serviceRow(db, serviceId).status, "provisioning_error");

  // The one slot is taken by a client request: reviving the failed row must be refused.
  const req = await request(db, serviceId, domainId, "taken");
  assert.ok(req.ok);
  const refused = await fulfill(db, serviceId, prov.value.mailbox.id);
  assert.ok(!refused.ok);
  if (!refused.ok) assert.equal(refused.code, "allowance_exhausted");

  assert.ok((await declineMailboxRequest(db, { serviceId, mailboxId: req.value.mailbox.id, reason: "test", actor: STAFF })).ok);
  const f = await fulfill(db, serviceId, prov.value.mailbox.id);
  assert.ok(f.ok);
  assert.equal(f.value.mailbox.status, "active");
  assert.equal(f.value.mailbox.failure_code, null);
  assert.equal(serviceRow(db, serviceId).status, "pending_setup");

  // ...which now satisfies activation.
  assert.ok((await transitionService(db, { serviceId, action: "activate", reason: null, expiresAt: null, actor: STAFF })).ok);
});
