// Altaventures' integration registry (staff side, /api/app/mail-integrations/*):
// the secret is shown once and only its hash stored, rotation invalidates
// the old secret immediately, mutations are owner/admin only, and the
// detail view reports the grantable set by source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as listRoute, onRequestPost as createRoute } from "../../functions/api/app/mail-integrations/index";
import { onRequestGet as detailRoute, onRequestPatch as patchRoute } from "../../functions/api/app/mail-integrations/[id]";
import { onRequestPost as rotateRoute } from "../../functions/api/app/mail-integrations/[id]/rotate-secret";
import { onRequestPost as attachRoute } from "../../functions/api/app/mail-integrations/[id]/mailboxes";
import { authenticateIntegration } from "../../functions/_lib/mailConnect/admin";
import type { StaffUser } from "../../functions/_lib/roles";
import { A, S, seedConnect } from "./helpers";

const owner: StaffUser = { id: "user_staff_owner", email: "owner@altasme.com", full_name: "Owner", role: "owner" };
const sales: StaffUser = { id: "user_staff_owner", email: "owner@altasme.com", full_name: "Owner", role: "sales" };

async function staffCall(fn: unknown, db: unknown, staffUser: StaffUser, init: { method?: string; params?: Record<string, string>; body?: unknown } = {}) {
  const res = await (fn as (ctx: unknown) => Promise<Response>)({
    request: new Request("https://clientkeeper.altasme.com/x", { method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    env: { DB: db },
    params: init.params ?? {},
    data: { staffUser },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("create: owner/admin only; returns the secret once; list and detail never include it or its hash", async () => {
  const f = await seedConnect();
  assert.equal((await staffCall(createRoute, f.db, sales, { method: "POST", body: { clientId: "client_a", name: "X" } })).status, 403);
  assert.equal((await staffCall(createRoute, f.db, owner, { method: "POST", body: { clientId: "nope", name: "X" } })).status, 400);
  const created = await staffCall(createRoute, f.db, owner, { method: "POST", body: { clientId: "client_a", name: "New Panel" } });
  assert.equal(created.status, 201);
  const secret = created.body.secret as string;
  assert.match(secret, /^wmc_[0-9a-f-]{36}_[0-9a-f]{64}$/);
  const listed = await staffCall(listRoute, f.db, sales);
  const detail = await staffCall(detailRoute, f.db, sales, { params: { id: (created.body.integration as { id: string }).id } });
  for (const r of [listed, detail]) {
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(secret.slice(-64)) && !text.includes("secret"), "no secret or hash in list/detail");
  }
});

test("rotate: the old secret stops working immediately, the new one works", async () => {
  const f = await seedConnect();
  assert.ok(await authenticateIntegration(f.db, `Bearer ${f.intA.secret}`));
  const r = await staffCall(rotateRoute, f.db, owner, { method: "POST", params: { id: f.intA.id } });
  assert.equal(r.status, 200);
  assert.equal(await authenticateIntegration(f.db, `Bearer ${f.intA.secret}`), null);
  assert.equal((await authenticateIntegration(f.db, `Bearer ${r.body.secret as string}`))?.id, f.intA.id);
  assert.equal((await staffCall(rotateRoute, f.db, sales, { method: "POST", params: { id: f.intA.id } })).status, 403);
});

test("disable via PATCH refuses the secret; re-enable restores it", async () => {
  const f = await seedConnect();
  assert.equal((await staffCall(patchRoute, f.db, sales, { method: "PATCH", params: { id: f.intA.id }, body: { status: "disabled" } })).status, 403);
  assert.equal((await staffCall(patchRoute, f.db, owner, { method: "PATCH", params: { id: f.intA.id }, body: { status: "paused" } })).status, 400);
  assert.equal((await staffCall(patchRoute, f.db, owner, { method: "PATCH", params: { id: f.intA.id }, body: { status: "disabled" } })).status, 200);
  assert.equal(await authenticateIntegration(f.db, `Bearer ${f.intA.secret}`), null);
  await staffCall(patchRoute, f.db, owner, { method: "PATCH", params: { id: f.intA.id }, body: { status: "active" } });
  assert.ok(await authenticateIntegration(f.db, `Bearer ${f.intA.secret}`));
});

test("detail lists the grantable set by source: the client's hosted mailbox, plus staff-attached ones", async () => {
  const f = await seedConnect();
  const before = await staffCall(detailRoute, f.db, sales, { params: { id: f.intA.id } });
  assert.deepEqual((before.body.mailboxes as { emailAddress: string; source: string }[]).map((m) => [m.emailAddress, m.source]), [[A.email, "client_hosted"]]);
  assert.equal((await staffCall(attachRoute, f.db, sales, { method: "POST", params: { id: f.intA.id }, body: { address: S.email } })).status, 403);
  assert.equal((await staffCall(attachRoute, f.db, owner, { method: "POST", params: { id: f.intA.id }, body: { address: "missing@altasme.com" } })).status, 404);
  assert.equal((await staffCall(attachRoute, f.db, owner, { method: "POST", params: { id: f.intA.id }, body: { address: S.email } })).status, 201);
  const after = await staffCall(detailRoute, f.db, sales, { params: { id: f.intA.id } });
  assert.deepEqual((after.body.mailboxes as { emailAddress: string; source: string }[]).map((m) => [m.emailAddress, m.source]), [
    [A.email, "client_hosted"],
    [S.email, "attached"],
  ]);
});

test("staff can't attach ANOTHER client's hosted mailbox (the tenant boundary holds even against staff mistakes)", async () => {
  const f = await seedConnect();
  const { B } = await import("./helpers");
  const r = await staffCall(attachRoute, f.db, owner, { method: "POST", params: { id: f.intA.id }, body: { address: B.email } });
  assert.equal(r.status, 409);
  assert.equal((f.db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_client_integration_mailboxes`).get() as { n: number }).n, 0);
  // control: the client's own hosted mailbox may be attached (redundant but harmless)
  assert.equal((await staffCall(attachRoute, f.db, owner, { method: "POST", params: { id: f.intA.id }, body: { address: A.email } })).status, 201);
});

test("attaching a staff mailbox to an integration does NOT make it eligible for the mailbox-password login", async () => {
  const f = await seedConnect();
  await staffCall(attachRoute, f.db, owner, { method: "POST", params: { id: f.intA.id }, body: { address: S.email } });
  const { findEligibleAccountByEmail } = await import("../../functions/_lib/mailClient/account");
  assert.equal(await findEligibleAccountByEmail(f.db, S.email), null);
});
