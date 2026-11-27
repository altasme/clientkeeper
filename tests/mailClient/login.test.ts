// Mailbox-owner login (CLAUDE.md §36): the password is checked by a real
// SMTP AUTH exchange -- @altasme/webmail-kit's smtpVerifyLogin(), the exact
// protocol code production runs -- against a scripted in-memory SMTP
// server that only accepts the mailbox's real credentials. Nothing is sent,
// nothing about the password is stored, and every failure looks the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { smtpVerifyLogin, type SmtpConfig } from "@altasme/webmail-kit/smtp";
import { handleMailClientLogin, LOGIN_FAILED_EVENT, MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP, type SmtpLoginVerifier } from "../../functions/_lib/mailClient/login";
import { verifyMailClientSessionCookie } from "../../functions/_lib/mailClient/session";
import { createFakeSmtp } from "../mail/fakeSmtp";
import { A, B, S, SECRET, cookiePair, makeCtx, seedMail } from "./helpers";

// Each fake server knows exactly one real login, keyed by host.
const REAL: Record<string, { username: string; password: string }> = {
  "smtp.acme.test": { username: A.email, password: A.password },
  "smtp.beta.test": { username: B.email, password: B.password },
  "smtp.altasme.test": { username: S.email, password: S.password },
};

function recordingVerifier(override?: (c: SmtpConfig) => SmtpLoginVerifier | null) {
  const calls: { host: string; username: string }[] = [];
  const logs: string[][] = [];
  const verify: SmtpLoginVerifier = async (config, username, password) => {
    calls.push({ host: config.host, username });
    const o = override?.(config);
    if (o) return o(config, username, password);
    const { connector, log } = createFakeSmtp({ credentials: REAL[config.host]! });
    logs.push(log.commands);
    return smtpVerifyLogin(connector, config, username, password);
  };
  return { verify, calls, logs };
}

async function login(env: ReturnType<typeof seedMail>["env"], email: string, password: string, verify: SmtpLoginVerifier, opts: { ip?: string; contentType?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.ip ?? "203.0.113.7" };
  if (opts.origin) headers.origin = opts.origin;
  const { ctx } = makeCtx(env, "/api/mail-client/login", { method: "POST", body: { email, password }, headers, contentType: opts.contentType });
  const res = await handleMailClientLogin(ctx, { verify, minFailureMs: 0 });
  return { res, status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function allDbText(db: ReturnType<typeof seedMail>["db"]): string {
  const tables = (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  let out = "";
  for (const t of tables) {
    try {
      out += JSON.stringify(db.raw.prepare(`SELECT * FROM "${t}"`).all());
    } catch {
      /* fts shadow tables etc. */
    }
  }
  return out;
}

test("correct password: 200, a client session cookie for that mailbox, AUTH done with the submitted password, no message sent", async () => {
  const { db, env } = seedMail();
  const { verify, calls, logs } = recordingVerifier();
  const r = await login(env, "  Ana@ACME.ph ", A.password, verify);
  assert.equal(r.status, 200);
  assert.equal(r.json.emailAddress, A.email);
  assert.deepEqual(calls, [{ host: "smtp.acme.test", username: A.email }]);
  const verbs = logs[0]!.map((c) => c.split(" ")[0]);
  assert.deepEqual(verbs, ["EHLO", "AUTH", "QUIT"], "no MAIL FROM / RCPT / DATA");
  const setCookie = r.res.headers.get("set-cookie")!;
  const session = await verifyMailClientSessionCookie(SECRET, cookiePair(setCookie));
  assert.equal(session?.mailAccountId, A.id);
  // the password appears nowhere: not the DB, not the cookie, not the body
  assert.equal(allDbText(db).includes(A.password), false);
  assert.equal(setCookie.includes(A.password), false);
  assert.equal(JSON.stringify(r.json).includes(A.password), false);
});

test("the profile's OUTBOUND password is not accepted as the login password", async () => {
  const { env } = seedMail();
  const { verify } = recordingVerifier();
  assert.equal((await login(env, A.email, "outbound-a", verify)).status, 401);
});

test("every failure is the same response: wrong password, unknown address, staff mailbox, invalid input", async () => {
  const { env } = seedMail();
  const { verify, calls } = recordingVerifier();
  const wrong = await login(env, A.email, "nope", verify, { ip: "1.1.1.1" });
  const unknown = await login(env, "nobody@acme.ph", "nope", verify, { ip: "1.1.1.2" });
  const staff = await login(env, S.email, S.password, verify, { ip: "1.1.1.3" }); // right password, but not client-hosted
  const empty = await login(env, A.email, "", verify, { ip: "1.1.1.4" });
  for (const r of [wrong, unknown, staff, empty]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, wrong.json);
  }
  assert.deepEqual(calls.map((c) => c.host), ["smtp.acme.test"], "SMTP is only contacted for an eligible mailbox with a non-empty password");
});

test("another mailbox's password doesn't open this one", async () => {
  const { env } = seedMail();
  const { verify } = recordingVerifier();
  assert.equal((await login(env, A.email, B.password, verify)).status, 401);
  assert.equal((await login(env, B.email, B.password, verify)).status, 200);
});

test("a client mailbox pointed at a profile whose username is a different address is refused without contacting SMTP", async () => {
  const { db, env } = seedMail();
  db.raw.exec(`UPDATE mail_accounts SET smtp_profile = 'staff-sales' WHERE id = '${A.id}'`);
  const { verify, calls } = recordingVerifier();
  assert.equal((await login(env, A.email, S.password, verify)).status, 401);
  assert.equal(calls.length, 0);
});

test("no SMTP profile configured in this environment -> refused (this is what happens if MAIL_SMTP_PROFILES_JSON isn't set on Pages)", async () => {
  const { env } = seedMail();
  const { verify, calls } = recordingVerifier();
  const r = await login({ ...env, MAIL_SMTP_PROFILES_JSON: undefined }, A.email, A.password, verify);
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test(`lockout: ${MAX_FAILURES_PER_EMAIL} failures per address lock it (even the right password), unknown addresses identically`, async () => {
  const { env } = seedMail();
  const { verify } = recordingVerifier();
  for (const email of [A.email, "ghost@acme.ph"]) {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) assert.equal((await login(env, email, "wrong", verify, { ip: `10.0.${email.length}.${i}` })).status, 401);
    const locked = await login(env, email, email === A.email ? A.password : "wrong", verify, { ip: "10.9.9.9" });
    assert.equal(locked.status, 429, email);
  }
  // B is unaffected
  assert.equal((await login(env, B.email, B.password, verify)).status, 200);
});

test(`lockout: ${MAX_FAILURES_PER_IP} failures from one IP lock that IP across addresses`, async () => {
  const { env } = seedMail();
  const { verify } = recordingVerifier();
  for (let i = 0; i < MAX_FAILURES_PER_IP; i++) await login(env, `guess${i}@acme.ph`, "wrong", verify, { ip: "198.51.100.1" });
  assert.equal((await login(env, B.email, B.password, verify, { ip: "198.51.100.1" })).status, 429);
  assert.equal((await login(env, B.email, B.password, verify, { ip: "198.51.100.2" })).status, 200);
});

test("an SMTP outage or timeout is a generic failure but never counts toward the lockout", async () => {
  const { db, env } = seedMail();
  const down = recordingVerifier(() => async () => ({ ok: false, reason: "connection_failed" }));
  for (let i = 0; i < MAX_FAILURES_PER_EMAIL + 2; i++) assert.equal((await login(env, A.email, A.password, down.verify)).status, 401);
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM mail_events WHERE event_type = ?`).get(LOGIN_FAILED_EVENT) as { n: number }).n, 0);
  const { verify } = recordingVerifier();
  assert.equal((await login(env, A.email, A.password, verify)).status, 200);
});

test("failure records hold only HMAC keys: no raw address, IP or password", async () => {
  const { db, env } = seedMail();
  const { verify } = recordingVerifier();
  await login(env, "secret-person@acme.ph", "hunter2-password", verify, { ip: "192.0.2.55" });
  const text = allDbText(db);
  for (const s of ["secret-person", "192.0.2.55", "hunter2-password"]) assert.equal(text.includes(s), false, s);
});

test("login CSRF: a non-JSON body (e.g. a cross-site text/plain form) or a foreign Origin is refused before anything else", async () => {
  const { env } = seedMail();
  const { verify, calls } = recordingVerifier();
  assert.equal((await login(env, A.email, A.password, verify, { contentType: "text/plain" })).status, 415);
  assert.equal((await login(env, A.email, A.password, verify, { origin: "https://evil.example" })).status, 403);
  assert.equal(calls.length, 0);
});

test("failure responses are padded to a minimum time (an unknown address isn't visibly faster)", async () => {
  const { env } = seedMail();
  const { verify } = recordingVerifier();
  const { ctx } = makeCtx(env, "/api/mail-client/login", { method: "POST", body: { email: "nobody@acme.ph", password: "x" } });
  const t0 = Date.now();
  const res = await handleMailClientLogin(ctx, { verify, minFailureMs: 300 });
  assert.equal(res.status, 401);
  assert.ok(Date.now() - t0 >= 290);
});
