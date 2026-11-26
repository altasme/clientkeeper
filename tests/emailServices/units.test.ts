import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { callProvider } from "../../functions/_lib/emailServices/provider/call";
import { reconcileMailboxes } from "../../functions/_lib/emailServices/reconcile";
import { addInterval, computeAllowance, effectiveServiceStatus, mailboxCountsAgainstAllowance } from "../../functions/_lib/emailServices/policy";
import { normalizeDomain, normalizeLocalPart, validateMailboxPassword } from "../../functions/_lib/emailServices/validation";
import { validatePlanBody } from "../../functions/_lib/emailServices/plans";
import { CLIENTHUB_SCHEMA_PATH, FIXTURE_SCHEMA_PATH } from "./d1Shim";

test("callProvider: a hung call becomes timeout/unknown, a thrown error becomes unknown", async () => {
  const hung = await callProvider(() => new Promise(() => {}), 30);
  assert.equal(hung.result.ok, false);
  if (!hung.result.ok) assert.deepEqual([hung.result.error.code, hung.result.error.outcome], ["timeout", "unknown"]);
  const thrown = await callProvider(() => Promise.reject(new Error("boom")));
  assert.equal(thrown.result.ok, false);
  if (!thrown.result.ok) assert.deepEqual([thrown.result.error.code, thrown.result.error.outcome], ["provider_error", "unknown"]);
});

test("policy: counted statuses, allowance math, effective expiry, intervals", () => {
  const now = "2026-11-25T00:00:00.000Z";
  assert.equal(mailboxCountsAgainstAllowance("active", null, now), true);
  assert.equal(mailboxCountsAgainstAllowance("failed", null, now), false);
  assert.equal(mailboxCountsAgainstAllowance("reserved", "2026-11-25T00:01:00.000Z", now), true);
  assert.equal(mailboxCountsAgainstAllowance("reserved", "2026-11-24T00:00:00.000Z", now), false);
  assert.equal(mailboxCountsAgainstAllowance("reserved", null, now), true, "a client request (no lease) holds its slot");
  assert.deepEqual(computeAllowance({ included: 10, additional: 5, overrides: 0, active: 4, pending: 0 }), { included: 10, additional: 5, overrides: 0, total: 15, active: 4, pending: 0, available: 11 });
  assert.equal(effectiveServiceStatus("active", "2026-01-01T00:00:00.000Z", now), "expired");
  assert.equal(effectiveServiceStatus("suspended", "2026-01-01T00:00:00.000Z", now), "suspended");
  assert.equal(addInterval("2026-11-25T00:00:00.000Z", "annual"), "2027-11-25T00:00:00.000Z");
});

test("validation", () => {
  assert.equal(normalizeDomain("https://www.Acme.PH/"), "acme.ph");
  assert.equal(normalizeDomain("bad_domain.com"), null);
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeLocalPart("Juan.Dela-Cruz"), "juan.dela-cruz");
  assert.equal(normalizeLocalPart("a..b"), null);
  assert.equal(normalizeLocalPart("a b"), null);
  assert.equal(validateMailboxPassword("short1").ok, false);
  assert.equal(validateMailboxPassword("onlyletterslong").ok, false);
  assert.equal(validateMailboxPassword("GoodPass1234").ok, true);
});

test("plan validation: full create, partial update, rejects bad values", () => {
  const ok = validatePlanBody({ name: "Pro", pricePhp: 3000, billingInterval: "annual", includedMailboxes: 5, storageQuotaMb: 5120, additionalMailboxPricePhp: 250, features: ["Spam protection"] }, null);
  assert.ok(ok.ok);
  assert.ok(!validatePlanBody({ name: "Pro" }, null).ok);
  assert.ok(!validatePlanBody({ name: "Pro", pricePhp: -1, billingInterval: "annual", includedMailboxes: 5, storageQuotaMb: 5120, additionalMailboxPricePhp: 250 }, null).ok);
  if (ok.ok) {
    const existing = { id: "p", ...ok.fields, updated_by: null, created_at: "", updated_at: "" };
    const partial = validatePlanBody({ status: "archived" }, existing);
    assert.ok(partial.ok);
    if (partial.ok) assert.deepEqual([partial.fields.status, partial.fields.price_php], ["archived", 3000]);
  }
});

test("reconcile: classifies every discrepancy type", () => {
  const local = [
    { id: "1", address: "ok@a.ph", status: "active" as const, providerMailboxId: "p1" },
    { id: "2", address: "gone@a.ph", status: "active" as const, providerMailboxId: "p2" },
    { id: "3", address: "rev1@a.ph", status: "needs_review" as const, providerMailboxId: null },
    { id: "4", address: "rev2@a.ph", status: "needs_review" as const, providerMailboxId: null },
    { id: "5", address: "fail@a.ph", status: "failed" as const, providerMailboxId: null },
    { id: "6", address: "idm@a.ph", status: "active" as const, providerMailboxId: "old" },
    { id: "7", address: "susp@a.ph", status: "active" as const, providerMailboxId: "p7" },
  ];
  const remote = [
    { providerMailboxId: "p1", address: "ok@a.ph", status: "active" as const },
    { providerMailboxId: "p3", address: "rev1@a.ph", status: "active" as const },
    { providerMailboxId: "p5", address: "fail@a.ph", status: "active" as const },
    { providerMailboxId: "new", address: "idm@a.ph", status: "active" as const },
    { providerMailboxId: "p7", address: "susp@a.ph", status: "suspended" as const },
    { providerMailboxId: "x1", address: "extra@a.ph", status: "active" as const },
    { providerMailboxId: "x2", address: "extra@a.ph", status: "active" as const },
  ];
  const types = reconcileMailboxes(local, remote, 5).map((d) => d.type).sort();
  assert.deepEqual(types, ["duplicate_at_provider", "failed_but_exists", "local_only", "over_allowance", "provider_id_mismatch", "provider_only", "provider_only", "review_absent", "review_exists", "status_mismatch"]);
  assert.deepEqual(reconcileMailboxes([local[0]!], [remote[0]!], 5), []);
});

test("schema drift guard: the fixture's Email Services block matches clienthub's canonical schema", (t) => {
  if (!existsSync(CLIENTHUB_SCHEMA_PATH)) {
    t.skip("no clienthub checkout next to this repo");
    return;
  }
  const marker = "-- =====================================================================\n-- Email Services";
  const block = (s: string) => s.slice(s.indexOf(marker)).trim();
  assert.equal(block(readFileSync(FIXTURE_SCHEMA_PATH, "utf8")), block(readFileSync(CLIENTHUB_SCHEMA_PATH, "utf8")));
});

test("auth host allowlist: known hosts keep their origin, anything else falls back to the canonical host", async () => {
  const { resolveHost } = await import("../../functions/_lib/hosts");
  assert.deepEqual(resolveHost("https://clientkeeper.altasme.com/api/auth-start"), { origin: "https://clientkeeper.altasme.com", homePath: "/" });
  assert.deepEqual(resolveHost("https://MAIL.altasme.com/api/auth-callback?code=x"), { origin: "https://mail.altasme.com", homePath: "/mail" });
  assert.deepEqual(resolveHost("https://evil.example.com/api/auth-start"), { origin: "https://clientkeeper.altasme.com", homePath: "/" });
  assert.deepEqual(resolveHost("https://clientkeeper.pages.dev/"), { origin: "https://clientkeeper.altasme.com", homePath: "/" });
});
