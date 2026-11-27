// The integration-facing admin API (/api/mail-connect/admin/*): bearer
// authentication, the cross-tenant grant boundary, grant upsert/list/
// revoke, the default-mailbox rule, and launch-code issuance. Real route
// handlers (through integrationHandler), real SQL, FKs ON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestDelete as revokeRoute, onRequestGet as listRoute, onRequestPost as upsertRoute } from "../../functions/api/mail-connect/admin/grants";
import { onRequestPost as launchRoute } from "../../functions/api/mail-connect/admin/launch";
import { sha256Hex } from "../../functions/_lib/mailConnect/admin";
import { A, B, S, attach, bearer, call, seedConnect } from "./helpers";

const POST = (body: unknown, secret: string) => ({ method: "POST", body, headers: bearer(secret) });

test("auth: wrong secret, malformed header, another integration's id, missing header and a DISABLED integration all get the same 401", async () => {
  const f = await seedConnect();
  const body = { externalUserId: "u-1", address: A.email };
  const tamperedTail = f.intA.secret.slice(0, -1) + (f.intA.secret.endsWith("a") ? "b" : "a");
  const swappedId = `wmc_${f.intB.id}_${f.intA.secret.slice(-64)}`;
  const cases: Record<string, string>[] = [{ authorization: `Bearer ${tamperedTail}` }, { authorization: `Bearer ${swappedId}` }, { authorization: f.intA.secret }, { authorization: "Bearer nope" }, {}];
  const bodies = new Set<string>();
  for (const headers of cases) {
    const r = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", { method: "POST", body, headers });
    assert.equal(r.status, 401, JSON.stringify(headers));
    bodies.add(r.text);
  }
  f.db.raw.prepare(`UPDATE mail_client_integrations SET status = 'disabled' WHERE id = ?`).run(f.intA.id);
  const disabled = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST(body, f.intA.secret));
  assert.equal(disabled.status, 401);
  bodies.add(disabled.text);
  assert.equal(bodies.size, 1, "every auth failure has the identical body");
  assert.equal((f.db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_external_mailbox_access`).get() as { n: number }).n, 0);
});

test("the raw secret is never stored: only its SHA-256, and no table contains the secret", async () => {
  const f = await seedConnect();
  const row = f.db.raw.prepare(`SELECT secret_hash FROM mail_client_integrations WHERE id = ?`).get(f.intA.id) as { secret_hash: string };
  assert.equal(row.secret_hash, await sha256Hex(f.intA.secret));
  const tables = f.db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'`).all() as { name: string }[];
  for (const { name } of tables) {
    for (const r of f.db.raw.prepare(`SELECT * FROM "${name}"`).all()) assert.ok(!JSON.stringify(r).includes(f.intA.secret.slice(-64)), `secret found in ${name}`);
  }
});

test("cross-tenant: client A's integration can grant its own hosted mailbox, but NOT client B's mailbox or the staff mailbox S", async () => {
  const f = await seedConnect();
  const ok = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: A.email }, f.intA.secret));
  assert.equal(ok.status, 200);
  for (const address of [B.email, S.email, "nobody@acme.ph"]) {
    const r = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address }, f.intA.secret));
    assert.equal(r.status, 404, address);
    assert.equal(r.json?.error, "Mailbox not found.", "another client's mailbox looks exactly like a nonexistent one");
  }
  const rows = f.db.raw.prepare(`SELECT integration_id, mail_account_id FROM mail_external_mailbox_access`).all() as { integration_id: string; mail_account_id: string }[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ integration_id: f.intA.id, mail_account_id: A.id }]);
  // control: client B's integration CAN grant B
  assert.equal((await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: B.email }, f.intB.secret))).status, 200);
});

test("cross-tenant: a mailbox moved out of client A's services stops being grantable (and suspended services too)", async () => {
  const f = await seedConnect();
  f.db.raw.exec(`UPDATE email_services SET status = 'suspended' WHERE id = 'svc-a'`);
  assert.equal((await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: A.email }, f.intA.secret))).status, 404);
  f.db.raw.exec(`UPDATE email_services SET status = 'active' WHERE id = 'svc-a'`);
  f.db.raw.exec(`UPDATE email_services SET client_id = 'client_b' WHERE id = 'svc-a'`);
  assert.equal((await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: A.email }, f.intA.secret))).status, 404);
});

test("staff allowlist: S becomes grantable ONLY for the integration staff attached it to", async () => {
  const f = await seedConnect();
  attach(f, f.intA.id, S.id);
  assert.equal((await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: S.email }, f.intA.secret))).status, 200);
  assert.equal((await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: S.email }, f.intB.secret))).status, 404);
});

test("upsert: permissions default to read-only, replace on re-grant, and isDefault moves the single default", async () => {
  const f = await seedConnect();
  attach(f, f.intA.id, S.id);
  const r1 = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: A.email, isDefault: true, grantedBy: "u-admin" }, f.intA.secret));
  const g1 = (r1.json!.grants as { address: string; permissions: Record<string, boolean>; isDefault: boolean; grantedBy: string }[])[0]!;
  assert.deepEqual(g1.permissions, { read: true, send: false, delete: false, manageSettings: false });
  assert.equal(g1.isDefault, true);
  assert.equal(g1.grantedBy, "u-admin");

  await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: S.email, permissions: { send: true }, isDefault: true }, f.intA.secret));
  // re-grant A without isDefault: permissions replaced, default flag left alone (S keeps it)
  const r3 = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: A.email, permissions: { send: true, delete: true } }, f.intA.secret));
  const grants = r3.json!.grants as { address: string; permissions: Record<string, boolean>; isDefault: boolean }[];
  assert.deepEqual(
    grants.map((g) => [g.address, g.isDefault, g.permissions.send, g.permissions.delete]),
    [
      [S.email, true, true, false],
      [A.email, false, true, true],
    ]
  );
  assert.equal((f.db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_external_mailbox_access WHERE is_default = 1`).get() as { n: number }).n, 1);
});

test("validation: bad externalUserId, address, permissions and non-JSON bodies are refused", async () => {
  const f = await seedConnect();
  for (const body of [
    { address: A.email },
    { externalUserId: "", address: A.email },
    { externalUserId: "x".repeat(201), address: A.email },
    { externalUserId: "a\u0000b", address: A.email },
    { externalUserId: "u-1", address: "not-an-email" },
    { externalUserId: "u-1", address: A.email, permissions: { send: "yes" } },
    { externalUserId: "u-1", address: A.email, isDefault: "true" },
  ]) {
    assert.equal((await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST(body, f.intA.secret))).status, 400, JSON.stringify(body));
  }
  const form = await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", { method: "POST", body: { externalUserId: "u-1", address: A.email }, headers: bearer(f.intA.secret), contentType: "text/plain" });
  assert.equal(form.status, 415);
});

test("list and revoke are scoped to the calling integration; revoking works even after the mailbox left the grantable set", async () => {
  const f = await seedConnect();
  await call(upsertRoute, f.env, "/api/mail-connect/admin/grants", POST({ externalUserId: "u-1", address: A.email }, f.intA.secret));
  // B's integration uses the SAME opaque user id: a different person, sees nothing of A's
  const other = await call(listRoute, f.env, "/api/mail-connect/admin/grants?externalUserId=u-1", { headers: bearer(f.intB.secret) });
  assert.deepEqual(other.json!.grants, []);
  const otherRevoke = await call(revokeRoute, f.env, "/api/mail-connect/admin/grants", { method: "DELETE", body: { externalUserId: "u-1", address: A.email }, headers: bearer(f.intB.secret) });
  assert.equal(otherRevoke.json!.revoked, false);
  assert.equal((f.db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_external_mailbox_access`).get() as { n: number }).n, 1);

  f.db.raw.exec(`UPDATE email_services SET status = 'suspended' WHERE id = 'svc-a'`);
  const listed = await call(listRoute, f.env, "/api/mail-connect/admin/grants?externalUserId=u-1", { headers: bearer(f.intA.secret) });
  assert.equal((listed.json!.grants as { available: boolean }[])[0]!.available, false);
  const revoked = await call(revokeRoute, f.env, "/api/mail-connect/admin/grants", { method: "DELETE", body: { externalUserId: "u-1", address: A.email }, headers: bearer(f.intA.secret) });
  assert.equal(revoked.json!.revoked, true);
  assert.equal((f.db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_external_mailbox_access`).get() as { n: number }).n, 0);
  assert.equal((f.db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_events WHERE event_type = 'connect_grant_revoked'`).get() as { n: number }).n, 1);
});

test("launch: issues a pending, ~60 s, 256-bit code on this request's origin, even for a user with no grants", async () => {
  const f = await seedConnect();
  const r = await call(launchRoute, f.env, "/api/mail-connect/admin/launch", POST({ externalUserId: "u-nobody", returnUrl: "https://panel.acme.ph/dashboard" }, f.intA.secret));
  assert.equal(r.status, 201);
  const url = new URL(r.json!.launchUrl as string);
  assert.equal(url.origin, "https://mail.altasme.com");
  assert.equal(url.pathname, "/api/mail-connect/exchange");
  const code = url.searchParams.get("code")!;
  assert.match(code, /^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  const row = f.db.raw.prepare(`SELECT * FROM mail_launch_codes WHERE code = ?`).get(code) as { status: string; expires_at: string; created_at: string; return_url: string; integration_id: string; external_user_id: string };
  assert.equal(row.status, "pending");
  assert.equal(row.integration_id, f.intA.id);
  assert.equal(row.external_user_id, "u-nobody");
  assert.equal(row.return_url, "https://panel.acme.ph/dashboard");
  const ttl = Date.parse(row.expires_at) - Date.parse(row.created_at);
  assert.ok(ttl > 0 && ttl <= 60_000, `ttl ${ttl}`);
});

test("launch: returnUrl must be an absolute http(s) URL without credentials", async () => {
  const f = await seedConnect();
  for (const returnUrl of ["javascript:alert(1)", "/relative", "ftp://x.test/", "https://user:pw@panel.test/", "data:text/html,hi"]) {
    assert.equal((await call(launchRoute, f.env, "/api/mail-connect/admin/launch", POST({ externalUserId: "u-1", returnUrl }, f.intA.secret))).status, 400, returnUrl);
  }
  for (const returnUrl of ["http://localhost:4000/", "https://any-host.example/panel"]) {
    assert.equal((await call(launchRoute, f.env, "/api/mail-connect/admin/launch", POST({ externalUserId: "u-1", returnUrl }, f.intA.secret))).status, 201, returnUrl);
  }
});
