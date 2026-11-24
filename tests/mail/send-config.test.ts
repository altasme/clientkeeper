import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_USER_SETTINGS, resolveSmtpConfig, sanitizeUserSettings, validatePolicyPatch } from "@altasme/webmail-kit/config";
import { toFtsQuery } from "@altasme/webmail-kit/query";
import { backoffMs, parseComposeBody } from "@altasme/webmail-kit/send";

test("exponential backoff with jitter bounds", () => {
  assert.equal(backoffMs(1, 0.5), 60_000);
  assert.equal(backoffMs(2, 0.5), 120_000);
  assert.equal(backoffMs(4, 0.5), 480_000);
  assert.ok(backoffMs(3, 0) >= 0.8 * 240_000 && backoffMs(3, 1) <= 1.2 * 240_000);
  assert.equal(backoffMs(20, 0.5), 60 * 60_000);
});

test("compose body validation", () => {
  const ok = parseComposeBody({ accountId: "acc", idempotencyKey: "abcdefgh1234", to: [{ email: "a@x.com" }], subject: "Hi\r\nBcc: x", html: "<p>x</p>" }, "new");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.input.subject, "Hi Bcc: x");
  const bad = parseComposeBody({ accountId: "acc", idempotencyKey: "abcdefgh1234", to: [{ email: "nope" }] }, "new");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.invalid, ["nope"]);
  assert.equal(parseComposeBody({ accountId: "acc", idempotencyKey: "short", to: [] }, "new").ok, false);
  assert.equal(parseComposeBody({ accountId: "acc", idempotencyKey: "abcdefgh1234", to: [] }, "reply").ok, false);
});

test("SMTP config resolution never needs the browser", () => {
  assert.equal(resolveSmtpConfig({}, null, "a@altasme.com"), null);
  const c = resolveSmtpConfig({ MAIL_SMTP_HOST: "smtp.x", MAIL_SMTP_PORT: "587", MAIL_SMTP_USERNAME: "u", MAIL_SMTP_PASSWORD: "p" }, null, "a@altasme.com");
  assert.equal(c?.security, "starttls");
  assert.equal(c?.clientName, "altasme.com");
  const p = resolveSmtpConfig({ MAIL_SMTP_PROFILES_JSON: JSON.stringify({ billing: { host: "h", port: 465, username: "b", password: "q" } }) }, "billing", "billing@altasme.com");
  assert.equal(p?.security, "tls");
  assert.equal(resolveSmtpConfig({ MAIL_SMTP_PROFILES_JSON: "{bad" }, "billing", "x@y.z"), null);
});

test("settings + policy whitelisting", () => {
  const s = sanitizeUserSettings({ density: "compact", refreshIntervalSec: 5, evil: "x", sound: "yes" });
  assert.equal(s.density, "compact");
  assert.equal(s.refreshIntervalSec, 30);
  assert.equal(s.sound, DEFAULT_USER_SETTINGS.sound);
  assert.equal("evil" in s, false);
  assert.equal(validatePolicyPatch({ maxRecipients: 1000 }).ok, false);
  assert.deepEqual(validatePolicyPatch({ maxRecipients: 20, remoteImagePolicy: "allow" }), { ok: true, values: { maxRecipients: 20, remoteImagePolicy: "allow" } });
});

test("FTS query escaping prevents operator injection", () => {
  assert.equal(toFtsQuery('invoice "OR" NEAR(x) a*b'), '"invoice"* "OR"* "NEARx"* "ab"*');
  assert.equal(toFtsQuery('  "" '), null);
});
