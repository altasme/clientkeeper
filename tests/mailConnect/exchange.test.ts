// Launch-code redemption (GET /api/mail-connect/exchange): single use,
// expiry, identical failures, integration status, and a concurrency test
// in the same style as the engine's slot-reservation tests (the D1 shim
// yields between statements, so concurrent calls genuinely interleave).

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as exchangeRoute } from "../../functions/api/mail-connect/exchange";
import { onRequestPost as launchRoute } from "../../functions/api/mail-connect/admin/launch";
import { handleExchange } from "../../functions/_lib/mailConnect/exchange";
import { me } from "../../functions/_lib/mailConnect/routes";
import { verifyMailConnectSessionCookie } from "../../functions/_lib/mailConnect/session";
import { A, SECRET, bearer, call, cookiePair, grant, seedConnect, type ConnectFixture } from "./helpers";

async function launch(f: ConnectFixture, externalUserId = "u-1", returnUrl?: string) {
  const r = await call(launchRoute, f.env, "/api/mail-connect/admin/launch", { method: "POST", body: { externalUserId, returnUrl }, headers: bearer(f.intA.secret) });
  const url = new URL(r.json!.launchUrl as string);
  return { path: `${url.pathname}${url.search}`, code: url.searchParams.get("code")! };
}

const isSuccess = (r: { status: number; res: Response }) => r.status === 302 && r.res.headers.get("location") === "/mail/connect" && /^ck_mail_connect_session=[^;]+\./.test(r.res.headers.get("set-cookie") ?? "");
const isFailure = (r: { status: number; res: Response }) => r.status === 302 && r.res.headers.get("location") === "/mail/connect?error=link" && /ck_mail_connect_session=;.*Max-Age=0/.test(r.res.headers.get("set-cookie") ?? "");

test("a fresh code redeems once into a working session; the session holds identity only and /me shows the live grants and return URL", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id, { send: true, isDefault: true });
  const { path } = await launch(f, "u-1", "https://panel.acme.ph/home");
  const r = await call(exchangeRoute, f.env, path);
  assert.ok(isSuccess(r));
  assert.equal(r.res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.res.headers.get("cache-control"), "no-store");
  const cookie = cookiePair(r.res.headers.get("set-cookie")!);
  const session = await verifyMailConnectSessionCookie(SECRET, cookie);
  assert.equal(session?.integrationId, f.intA.id);
  assert.equal(session?.externalUserId, "u-1");
  const meRes = await call(me, f.env, "/api/mail-connect/me", { cookie });
  assert.equal(meRes.json!.returnUrl, "https://panel.acme.ph/home");
  assert.deepEqual((meRes.json!.mailboxes as { emailAddress: string; canSend: boolean; isDefault: boolean }[]).map((m) => [m.emailAddress, m.canSend, m.isDefault]), [[A.email, true, true]]);
});

test("replay: the same code a second time fails exactly like a bad code (and clears any session cookie)", async () => {
  const f = await seedConnect();
  const { path } = await launch(f);
  assert.ok(isSuccess(await call(exchangeRoute, f.env, path)));
  assert.ok(isFailure(await call(exchangeRoute, f.env, path)));
  assert.equal((f.db.raw.prepare(`SELECT status FROM mail_launch_codes`).get() as { status: string }).status, "used");
});

test("expiry: a code redeemed after its 60 s window fails and is marked expired", async () => {
  const f = await seedConnect();
  const { path } = await launch(f);
  const r = await handleExchange({ request: new Request(`https://mail.altasme.com${path}`), env: f.env }, () => Date.now() + 61_000);
  assert.ok(isFailure({ status: r.status, res: r }));
  assert.equal((f.db.raw.prepare(`SELECT status FROM mail_launch_codes`).get() as { status: string }).status, "expired");
  // and it can't come back to life later
  assert.ok(isFailure(await call(exchangeRoute, f.env, path)));
});

test("bad codes all fail identically: malformed, unknown id, right id with wrong secret part, missing", async () => {
  const f = await seedConnect();
  const { code } = await launch(f);
  const [id, tail] = code.split(".") as [string, string];
  const wrongTail = tail.slice(0, -1) + (tail.endsWith("a") ? "b" : "a");
  for (const q of ["", "?code=", "?code=garbage", `?code=${crypto.randomUUID()}.${tail}`, `?code=${id}.${wrongTail}`, `?code=${id}`]) {
    assert.ok(isFailure(await call(exchangeRoute, f.env, `/api/mail-connect/exchange${q}`)), q);
  }
  // a wrong-secret attempt doesn't burn the real code
  assert.equal((f.db.raw.prepare(`SELECT status FROM mail_launch_codes`).get() as { status: string }).status, "pending");
  assert.ok(isSuccess(await call(exchangeRoute, f.env, `/api/mail-connect/exchange?code=${code}`)));
});

test("a disabled integration's pending code is refused (and burned); its live sessions end on the next request", async () => {
  const f = await seedConnect();
  grant(f, f.intA.id, "u-1", A.id);
  const first = await launch(f);
  const cookie = cookiePair((await call(exchangeRoute, f.env, first.path)).res.headers.get("set-cookie")!);
  const pending = await launch(f);
  assert.equal((await call(me, f.env, "/api/mail-connect/me", { cookie })).status, 200);
  f.db.raw.prepare(`UPDATE mail_client_integrations SET status = 'disabled' WHERE id = ?`).run(f.intA.id);
  const r = await call(me, f.env, "/api/mail-connect/me", { cookie });
  assert.equal(r.status, 401);
  assert.match(r.res.headers.get("set-cookie") ?? "", /ck_mail_connect_session=;.*Max-Age=0/);
  assert.ok(isFailure(await call(exchangeRoute, f.env, pending.path)));
  f.db.raw.prepare(`UPDATE mail_client_integrations SET status = 'active' WHERE id = ?`).run(f.intA.id);
  assert.ok(isFailure(await call(exchangeRoute, f.env, pending.path)), "burned, not just paused");
});

test("concurrency: 10 simultaneous redemptions of one code produce exactly 1 session", async () => {
  const f = await seedConnect();
  const { path } = await launch(f);
  const results = await Promise.all(Array.from({ length: 10 }, () => call(exchangeRoute, f.env, path)));
  assert.equal(results.filter(isSuccess).length, 1);
  assert.equal(results.filter(isFailure).length, 9);
});

test("negative control: a naive check-then-update claim lets more than one through under the same shim", async () => {
  // Proves the concurrency test above can detect the race it guards against.
  const f = await seedConnect();
  const { code } = await launch(f);
  const naive = async () => {
    const row = await f.db.prepare(`SELECT status FROM mail_launch_codes WHERE code = ?`).bind(code).first<{ status: string }>();
    if (row?.status !== "pending") return false;
    await f.db.prepare(`UPDATE mail_launch_codes SET status = 'used' WHERE code = ?`).bind(code).run();
    return true;
  };
  const won = (await Promise.all(Array.from({ length: 10 }, naive))).filter(Boolean).length;
  assert.ok(won > 1, `naive approach should double-claim, got ${won}`);
});
