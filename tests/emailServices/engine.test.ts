import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider, PASSWORD, STAFF, mailboxStatuses, seed, serviceRow } from "./helpers";
import {
  addDomain,
  adjustEntitlement,
  assignPlan,
  deleteMailbox,
  discardMailbox,
  getAllowance,
  provisionMailbox,
  removeDomain,
  resolveMailbox,
  retryMailbox,
  sweepExpiredServices,
  sweepStaleMailboxes,
  syncService,
  transitionService,
} from "../../functions/_lib/emailServices/engine";
import { NotConfiguredProvider, PROVIDER_NOT_CONFIGURED_MESSAGE } from "../../functions/_lib/emailServices/provider/notConfigured";
import { getEmailProvider } from "../../functions/_lib/emailServices/provider";
import { getServiceDetail } from "../../functions/_lib/emailServices/services";

const provision = (db: Parameters<typeof provisionMailbox>[0], provider: Parameters<typeof provisionMailbox>[1], serviceId: string, domainId: string, localPart: string, extra: Partial<Parameters<typeof provisionMailbox>[2]> = {}) =>
  provisionMailbox(db, provider, { serviceId, domainId, localPart, password: PASSWORD, isPrimary: false, idempotencyKey: null, actor: STAFF, ...extra });

// ---------------------------------------------------------------------------
// The placeholder provider

test("the registry only ever returns the honest placeholder today", () => {
  const p = getEmailProvider("zcom");
  assert.ok(p instanceof NotConfiguredProvider);
  assert.equal(p.status().configured, false);
});

test("placeholder: every operation fails not_configured / not_performed, never success", async () => {
  const p = new NotConfiguredProvider("zcom");
  const ref = { providerServiceId: null, address: "a@b.ph", providerMailboxId: null };
  const results = await Promise.all([
    p.listDomains({ providerServiceId: null }),
    p.listMailboxes({ providerServiceId: null, domain: "b.ph", providerDomainId: null }),
    p.getMailboxDetails(ref),
    p.createMailbox({ ...ref, domain: "b.ph", providerDomainId: null, localPart: "a", password: PASSWORD, storageQuotaMb: null, idempotencyKey: "k" }),
    p.deleteMailbox(ref),
    p.changeMailboxPassword({ ...ref, password: PASSWORD }),
    p.configureForwarding({ ...ref, forwardTo: ["x@y.ph"], keepCopy: true }),
    p.getServiceDetails({ providerServiceId: null }),
    p.getUsage({ providerServiceId: null }),
  ]);
  for (const r of results) {
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "not_configured");
      assert.equal(r.error.outcome, "not_performed");
      assert.equal(r.error.retryable, false);
      assert.ok(!r.error.message.includes(PASSWORD));
    }
  }
});

test("provisioning through the placeholder fails clearly and releases the slot", async () => {
  const { db, serviceId, domainId } = await seed();
  const before = (await getAllowance(db, serviceId))!;
  const r = await provision(db, new NotConfiguredProvider("zcom"), serviceId, domainId, "hello", { isPrimary: true });
  assert.ok(r.ok);
  assert.equal(r.value.mailbox.status, "failed");
  assert.equal(r.value.mailbox.failure_code, "not_configured");
  assert.equal(r.value.providerError?.message, PROVIDER_NOT_CONFIGURED_MESSAGE);
  const after = (await getAllowance(db, serviceId))!;
  assert.equal(after.available, before.available, "failed attempt must not hold a slot");
  assert.equal(after.active, 0);
  // primary mailbox failing on a pending service flags the service
  assert.equal(serviceRow(db, serviceId).status, "provisioning_error");
  const log = db.raw.prepare(`SELECT outcome, error_code FROM email_provisioning_logs WHERE operation = 'create_mailbox'`).get() as { outcome: string; error_code: string };
  assert.deepEqual({ ...log }, { outcome: "failed", error_code: "not_configured" });
  // the password never reaches the database
  const dump = JSON.stringify(db.raw.prepare(`SELECT * FROM email_mailboxes`).all()) + JSON.stringify(db.raw.prepare(`SELECT * FROM email_provisioning_logs`).all()) + JSON.stringify(db.raw.prepare(`SELECT * FROM email_audit_logs`).all());
  assert.ok(!dump.includes(PASSWORD));
});

test("sync with the placeholder reports an error and changes no mailbox", async () => {
  const { db, serviceId } = await seed();
  const r = await syncService(db, new NotConfiguredProvider("zcom"), { serviceId, actor: STAFF });
  assert.ok(r.ok);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.error?.code, "not_configured");
  assert.equal(serviceRow(db, serviceId).sync_status, "error");
});

// ---------------------------------------------------------------------------
// Successful provisioning (fake provider standing in for a future adapter)

test("success: mailbox becomes active with provider ids and the bridge-ready inbound source", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  const r = await provision(db, provider, serviceId, domainId, "Hello".toLowerCase(), { isPrimary: true });
  assert.ok(r.ok);
  const m = r.value.mailbox;
  assert.equal(m.status, "active");
  assert.equal(m.address, "hello@acme.ph");
  assert.equal(m.provider_mailbox_id, "zmail-1");
  assert.equal(m.provider_service_id, "zsvc-1");
  assert.equal(m.inbound_source, "zcom_poll_sync");
  assert.equal(m.mail_account_id, null);
  const a = (await getAllowance(db, serviceId))!;
  assert.deepEqual([a.total, a.active, a.available], [3, 1, 2]);
});

test("concurrency: 10 simultaneous requests against 3 slots create exactly 3 mailboxes", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "team" }); // 3 included
  const provider = new FakeProvider();
  provider.delayMs = 15;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => provision(db, provider, serviceId, domainId, `user${i}`)));
  const ok = results.filter((r) => r.ok && r.value.mailbox.status === "active");
  const refused = results.filter((r) => !r.ok);
  assert.equal(ok.length, 3);
  assert.equal(refused.length, 7);
  for (const r of refused) if (!r.ok) assert.equal(r.code, "allowance_exhausted");
  assert.equal(provider.createCalls, 3, "the provider must never be called for a request that got no slot");
  const a = (await getAllowance(db, serviceId))!;
  assert.deepEqual([a.total, a.active, a.available], [3, 3, 0]);
});

test("negative control: a naive check-then-insert oversubscribes under the same shim", async () => {
  // Proves the concurrency test above can detect the race it guards against.
  const { db, serviceId, domainId } = await seed({ planId: "team" });
  const naive = async (i: number) => {
    const a = (await getAllowance(db, serviceId))!;
    if (a.available <= 0) return false;
    await db
      .prepare(`INSERT INTO email_mailboxes (id, service_id, domain_id, local_part, address, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
      .bind(crypto.randomUUID(), serviceId, domainId, `n${i}`, `n${i}@acme.ph`, new Date().toISOString(), new Date().toISOString())
      .run();
    return true;
  };
  const made = (await Promise.all(Array.from({ length: 10 }, (_, i) => naive(i)))).filter(Boolean).length;
  assert.ok(made > 3, `naive approach should oversubscribe, made ${made}`);
});

test("idempotency: the same key sent twice at once reserves one slot and calls the provider once", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  const key = "req-1234567890";
  const [a, b] = await Promise.all([provision(db, provider, serviceId, domainId, "sales", { idempotencyKey: key }), provision(db, provider, serviceId, domainId, "sales", { idempotencyKey: key })]);
  assert.ok(a.ok && b.ok);
  assert.equal(provider.createCalls, 1);
  assert.equal([a, b].filter((r) => r.ok && r.value.duplicateRequest).length, 1);
  assert.equal(mailboxStatuses(db, serviceId).length, 1);
});

test("an address can only have one live record", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  assert.ok((await provision(db, provider, serviceId, domainId, "info")).ok);
  const dup = await provision(db, provider, serviceId, domainId, "info");
  assert.ok(!dup.ok);
  if (!dup.ok) assert.equal(dup.code, "address_taken");
});

test("only one live primary mailbox per service", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  assert.ok((await provision(db, provider, serviceId, domainId, "a", { isPrimary: true })).ok);
  const r = await provision(db, provider, serviceId, domainId, "b", { isPrimary: true });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.code, "primary_exists");
});

// ---------------------------------------------------------------------------
// Failure handling and the state machine

test("outcome unknown (adapter threw) holds the slot as needs_review; resolving 'absent' releases it", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" }); // 1 slot
  const provider = new FakeProvider();
  provider.createBehavior = "throw";
  const r = await provision(db, provider, serviceId, domainId, "owner");
  assert.ok(r.ok);
  assert.equal(r.value.mailbox.status, "needs_review");
  assert.equal((await getAllowance(db, serviceId))!.available, 0, "unknown outcome must keep the slot");
  const blocked = await provision(db, new FakeProvider(), serviceId, domainId, "other");
  assert.ok(!blocked.ok);

  const res = await resolveMailbox(db, { serviceId, mailboxId: r.value.mailbox.id, resolution: "absent", providerMailboxId: null, reason: "Checked Z.com panel", actor: STAFF });
  assert.ok(res.ok);
  assert.equal(res.value.mailbox.status, "failed");
  assert.equal((await getAllowance(db, serviceId))!.available, 1);
});

test("a provider 'duplicate' answer holds the slot for review rather than releasing it", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  provider.createBehavior = { code: "duplicate", message: "exists", outcome: "not_performed", retryable: false };
  const r = await provision(db, provider, serviceId, domainId, "x");
  assert.ok(r.ok);
  assert.equal(r.value.mailbox.status, "needs_review");
});

test("retry: a failed mailbox is retried in place, re-checking capacity", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" });
  const provider = new FakeProvider();
  provider.createBehavior = { code: "unavailable", message: "503", outcome: "not_performed", retryable: true };
  const first = await provision(db, provider, serviceId, domainId, "owner");
  assert.ok(first.ok && first.value.mailbox.status === "failed");
  provider.createBehavior = "ok";
  const again = await retryMailbox(db, provider, { serviceId, mailboxId: first.value.mailbox.id, password: PASSWORD, actor: STAFF });
  assert.ok(again.ok);
  assert.equal(again.value.mailbox.status, "active");
  assert.equal(again.value.mailbox.id, first.value.mailbox.id);
});

test("retry is refused when the slot was taken in the meantime", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" });
  const provider = new FakeProvider();
  provider.createBehavior = { code: "unavailable", message: "503", outcome: "not_performed", retryable: true };
  const first = await provision(db, provider, serviceId, domainId, "owner");
  assert.ok(first.ok);
  provider.createBehavior = "ok";
  assert.ok((await provision(db, provider, serviceId, domainId, "second")).ok);
  const again = await retryMailbox(db, provider, { serviceId, mailboxId: first.value.mailbox.id, password: PASSWORD, actor: STAFF });
  assert.ok(!again.ok);
  if (!again.ok) assert.equal(again.code, "allowance_exhausted");
});

test("discard hides a failed attempt and frees its address", async () => {
  const { db, serviceId, domainId } = await seed();
  const failed = await provision(db, new NotConfiguredProvider("zcom"), serviceId, domainId, "info");
  assert.ok(failed.ok);
  assert.ok((await discardMailbox(db, { serviceId, mailboxId: failed.value.mailbox.id, actor: STAFF })).ok);
  const again = await provision(db, new FakeProvider(), serviceId, domainId, "info");
  assert.ok(again.ok && again.value.mailbox.status === "active");
});

test("lease sweep: stale 'reserved' -> failed (released), stale 'provisioning' -> needs_review (held)", async () => {
  const { db, serviceId, domainId } = await seed();
  const now = new Date().toISOString();
  const ins = db.raw.prepare(`INSERT INTO email_mailboxes (id, service_id, domain_id, local_part, address, status, reserved_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run("m1", serviceId, domainId, "r", "r@acme.ph", "reserved", now, now, now);
  ins.run("m2", serviceId, domainId, "p", "p@acme.ph", "provisioning", now, now, now);
  const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.equal(await sweepStaleMailboxes(db, serviceId, later), 2);
  assert.deepEqual(mailboxStatuses(db, serviceId).sort(), ["failed", "needs_review"]);
  const a = (await getAllowance(db, serviceId, later))!;
  assert.deepEqual([a.pending, a.available], [1, 2]);
});

test("delete: slot is released only after provider confirmation; a refused delete restores the mailbox", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  const made = await provision(db, provider, serviceId, domainId, "info");
  assert.ok(made.ok);
  provider.deleteBehavior = { code: "unavailable", message: "down", outcome: "not_performed", retryable: true };
  const refused = await deleteMailbox(db, provider, { serviceId, mailboxId: made.value.mailbox.id, reason: "client asked", actor: STAFF });
  assert.ok(refused.ok);
  assert.equal(refused.value.mailbox.status, "active");
  assert.equal((await getAllowance(db, serviceId))!.active, 1);
  provider.deleteBehavior = "ok";
  const done = await deleteMailbox(db, provider, { serviceId, mailboxId: made.value.mailbox.id, reason: "client asked", actor: STAFF });
  assert.ok(done.ok);
  assert.equal(done.value.mailbox.status, "deleted");
  assert.equal((await getAllowance(db, serviceId))!.active, 0);
});

// ---------------------------------------------------------------------------
// Entitlements and plans

test("entitlements: add-ons raise the allowance; removals can't go below usage or below zero add-ons", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "solo" });
  const provider = new FakeProvider();
  assert.ok((await provision(db, provider, serviceId, domainId, "a")).ok);
  const add = await adjustEntitlement(db, { serviceId, kind: "addon", quantity: 2, reason: null, actor: STAFF });
  assert.ok(add.ok);
  assert.deepEqual([add.value.allowance.included, add.value.allowance.additional, add.value.allowance.total], [1, 2, 3]);
  assert.ok((await provision(db, provider, serviceId, domainId, "b")).ok);
  const tooMuch = await adjustEntitlement(db, { serviceId, kind: "addon", quantity: -2, reason: "refund", actor: STAFF });
  assert.ok(!tooMuch.ok);
  if (!tooMuch.ok) assert.equal(tooMuch.code, "below_usage");
  const negAddon = await adjustEntitlement(db, { serviceId, kind: "addon", quantity: -3, reason: "x", actor: STAFF });
  assert.ok(!negAddon.ok);
  assert.ok((await adjustEntitlement(db, { serviceId, kind: "addon", quantity: -1, reason: "refund", actor: STAFF })).ok);
  const noReason = await adjustEntitlement(db, { serviceId, kind: "override", quantity: 1, reason: null, actor: STAFF });
  assert.ok(!noReason.ok);
  const price = db.raw.prepare(`SELECT unit_price_php FROM email_service_entitlements WHERE quantity = 2`).get() as { unit_price_php: number };
  assert.equal(price.unit_price_php, 250);
});

test("plans: values are snapshotted; a downgrade below usage is refused; changing plans needs a reason", async () => {
  const { db, serviceId, domainId } = await seed({ planId: "team" });
  const provider = new FakeProvider();
  for (const n of ["a", "b"]) assert.ok((await provision(db, provider, serviceId, domainId, n)).ok);
  const noReason = await assignPlan(db, { serviceId, planId: "solo", reason: null, actor: STAFF });
  assert.ok(!noReason.ok);
  const down = await assignPlan(db, { serviceId, planId: "solo", reason: "budget", actor: STAFF });
  assert.ok(!down.ok);
  if (!down.ok) assert.equal(down.code, "below_usage");
  const up = await assignPlan(db, { serviceId, planId: "growth", reason: "growing", actor: STAFF });
  assert.ok(up.ok);
  assert.equal(up.value.service.included_mailboxes, 10);
  // editing the catalog afterwards doesn't change the service
  db.raw.prepare(`UPDATE email_plans SET included_mailboxes = 99, price_php = 1 WHERE id = 'growth'`).run();
  const s = serviceRow(db, serviceId);
  assert.deepEqual([s.included_mailboxes, s.price_php], [10, 4199]);
});

test("domains: one live owner per domain; removal blocked while mailboxes use it", async () => {
  const { db, serviceId, domainId } = await seed();
  const other = await seed({ domain: null });
  // a second database: domain uniqueness is per database, so test within one
  const dupe = await addDomain(db, { serviceId, domain: "acme.ph", isPrimary: false, actor: STAFF });
  assert.ok(!dupe.ok);
  if (!dupe.ok) assert.equal(dupe.code, "domain_taken");
  assert.ok(other.serviceId);
  assert.ok((await provision(db, new FakeProvider(), serviceId, domainId, "a")).ok);
  const blocked = await removeDomain(db, { serviceId, domainId, reason: null, actor: STAFF });
  assert.ok(!blocked.ok);
});

// ---------------------------------------------------------------------------
// Lifecycle

test("lifecycle: activation needs plan+domain+active mailbox; suspension blocks provisioning; decommission needs no mailboxes", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  const early = await transitionService(db, { serviceId, action: "activate", reason: null, expiresAt: null, actor: STAFF });
  assert.ok(!early.ok);
  if (!early.ok) assert.equal(early.code, "activation_requirements");

  const made = await provision(db, provider, serviceId, domainId, "hello", { isPrimary: true });
  assert.ok(made.ok);
  const act = await transitionService(db, { serviceId, action: "activate", reason: null, expiresAt: null, actor: STAFF });
  assert.ok(act.ok);
  assert.equal(act.value.service.status, "active");
  assert.ok(act.value.service.expires_at! > new Date().toISOString());

  assert.ok(!(await transitionService(db, { serviceId, action: "suspend", reason: null, expiresAt: null, actor: STAFF })).ok, "suspend needs a reason");
  assert.ok((await transitionService(db, { serviceId, action: "suspend", reason: "non-payment", expiresAt: null, actor: STAFF })).ok);
  const blocked = await provision(db, provider, serviceId, domainId, "two");
  assert.ok(!blocked.ok);
  if (!blocked.ok) assert.equal(blocked.code, "service_not_provisionable");
  assert.equal(mailboxStatuses(db, serviceId).filter((s) => s === "active").length, 1, "suspension never deletes mailboxes");

  assert.ok((await transitionService(db, { serviceId, action: "reactivate", reason: null, expiresAt: null, actor: STAFF })).ok);
  const decom = await transitionService(db, { serviceId, action: "decommission", reason: "closed", expiresAt: null, actor: STAFF });
  assert.ok(!decom.ok);
  if (!decom.ok) assert.equal(decom.code, "mailboxes_remain");
  assert.ok((await deleteMailbox(db, provider, { serviceId, mailboxId: made.value.mailbox.id, reason: "closing", actor: STAFF })).ok);
  const ok = await transitionService(db, { serviceId, action: "decommission", reason: "closed", expiresAt: null, actor: STAFF });
  assert.ok(ok.ok);
  assert.equal(ok.value.service.status, "cancelled");
});

test("expiry: past expires_at blocks provisioning immediately, the sweep marks it expired, renew restores it", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  assert.ok((await provision(db, provider, serviceId, domainId, "hello", { isPrimary: true })).ok);
  assert.ok((await transitionService(db, { serviceId, action: "activate", reason: null, expiresAt: null, actor: STAFF })).ok);
  const past = new Date(Date.now() - 1000).toISOString();
  db.raw.prepare(`UPDATE email_services SET expires_at = ? WHERE id = ?`).run(past, serviceId);

  const blocked = await provision(db, provider, serviceId, domainId, "late");
  assert.ok(!blocked.ok, "no provisioning on an expired term even before the sweep");
  assert.equal(await sweepExpiredServices(db, serviceId), 1);
  assert.equal(serviceRow(db, serviceId).status, "expired");
  assert.equal(mailboxStatuses(db, serviceId).filter((s) => s === "active").length, 1, "expiry never deletes mailboxes");

  const renewed = await transitionService(db, { serviceId, action: "renew", reason: null, expiresAt: null, actor: STAFF });
  assert.ok(renewed.ok);
  assert.equal(renewed.value.service.status, "active");
  assert.ok((await provision(db, provider, serviceId, domainId, "late")).ok);
});

// ---------------------------------------------------------------------------
// Sync (with a working fake provider) never changes mailboxes

test("sync reports discrepancies without touching any mailbox", async () => {
  const { db, serviceId, domainId } = await seed();
  const provider = new FakeProvider();
  const made = await provision(db, provider, serviceId, domainId, "hello");
  assert.ok(made.ok);
  provider.remote = [{ providerServiceId: "zsvc-1", providerMailboxId: "zmail-99", address: "rogue@acme.ph", status: "active", storageUsedMb: 1, storageQuotaMb: null }];
  const before = mailboxStatuses(db, serviceId);
  const r = await syncService(db, provider, { serviceId, actor: STAFF });
  assert.ok(r.ok && r.value.ok);
  const types = r.value.discrepancies.map((d) => d.type).sort();
  assert.deepEqual(types, ["local_only", "provider_only"]);
  assert.deepEqual(mailboxStatuses(db, serviceId), before);
  assert.equal(serviceRow(db, serviceId).sync_status, "discrepancies");
});

test("detail read model exposes allowance, checklist, provider status, and bridge fields", async () => {
  const { db, serviceId, domainId } = await seed();
  await provision(db, new NotConfiguredProvider("zcom"), serviceId, domainId, "hello", { isPrimary: true });
  const d = await getServiceDetail(db, serviceId);
  assert.ok(d);
  assert.equal(d.provider.configured, false);
  assert.equal(d.allowance!.total, 3);
  assert.equal(d.status, "provisioning_error");
  assert.equal(d.mailboxes[0]!.inboundSource, "zcom_poll_sync");
  assert.equal(d.mailboxes[0]!.createdBy, "Admin");
});
