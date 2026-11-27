// @altasme/webmail-kit's smtpVerifyLogin(): the SMTP-AUTH-only credential
// check behind mailbox-owner login, run against the scripted fake server
// (tests/mail/fakeSmtp.ts). Imports the ./smtp subpath, never the barrel
// (which pulls in cloudflare:sockets). The cloudflare:sockets binding
// itself (verifySmtpLogin in smtpTransport.ts) can't run under Node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { smtpSend, smtpVerifyLogin, type SmtpConfig } from "@altasme/webmail-kit/smtp";
import { createFakeSmtp } from "../mail/fakeSmtp";

const creds = { username: "ana@acme.ph", password: "real-pw" };
// The config's OWN username/password are the outbound login; verify must ignore them.
const config: SmtpConfig = { host: "smtp.acme.test", port: 465, security: "tls", username: "ana@acme.ph", password: "outbound-pw", clientName: "acme.ph" };

test("right credentials: ok, AUTH carries the SUPPLIED password (not the config's), then QUIT; nothing is sent", async () => {
  const { connector, log } = createFakeSmtp({ credentials: creds });
  assert.deepEqual(await smtpVerifyLogin(connector, config, creds.username, creds.password), { ok: true });
  assert.deepEqual(log.commands.map((c) => c.split(" ")[0]), ["EHLO", "AUTH", "QUIT"]);
  assert.equal(log.commands[1], `AUTH PLAIN ${Buffer.from(`\0${creds.username}\0${creds.password}`).toString("base64")}`);
  assert.equal(log.data, "");
});

test("wrong password -> auth_failed; the config's own outbound password is not what gets tested", async () => {
  const { connector } = createFakeSmtp({ credentials: { username: "ana@acme.ph", password: "outbound-pw" } });
  assert.deepEqual(await smtpVerifyLogin(connector, config, creds.username, "real-pw"), { ok: false, reason: "auth_failed" });
});

test("STARTTLS (587) upgrades before AUTH; AUTH LOGIN fallback works", async () => {
  const tls = createFakeSmtp({ credentials: creds });
  assert.deepEqual(await smtpVerifyLogin(tls.connector, { ...config, port: 587, security: "starttls" }, creds.username, creds.password), { ok: true });
  assert.equal(tls.log.tlsUpgraded, true);
  assert.deepEqual(tls.log.commands.slice(0, 4).map((c) => c.split(" ")[0]), ["EHLO", "STARTTLS", "EHLO", "AUTH"]);

  const login = createFakeSmtp({ credentials: creds, authMechanisms: "LOGIN" });
  assert.deepEqual(await smtpVerifyLogin(login.connector, config, creds.username, creds.password), { ok: true });
  assert.equal(login.log.commands[1], "AUTH LOGIN");
  const bad = createFakeSmtp({ credentials: creds, authMechanisms: "LOGIN" });
  assert.deepEqual(await smtpVerifyLogin(bad.connector, config, creds.username, "nope"), { ok: false, reason: "auth_failed" });
});

test("empty or CR/LF/NUL-bearing credentials are refused without connecting (an empty username would otherwise skip AUTH)", async () => {
  let connected = 0;
  const { connector: inner } = createFakeSmtp({ authReply: "235 ok" });
  const connector: typeof inner = (o) => {
    connected++;
    return inner(o);
  };
  for (const [u, p] of [["", "x"], ["ana@acme.ph", ""], ["ana@acme.ph\r\nRSET", "x"], ["ana@acme.ph", "x\u0000y"]] as const) {
    assert.deepEqual(await smtpVerifyLogin(connector, config, u, p), { ok: false, reason: "auth_failed" });
  }
  assert.equal(connected, 0);
});

test("a server that accepts any AUTH still can't make an empty-password login succeed", async () => {
  const { connector } = createFakeSmtp({ authReply: "235 2.7.0 anything goes" });
  assert.deepEqual(await smtpVerifyLogin(connector, config, creds.username, ""), { ok: false, reason: "auth_failed" });
});

test("plaintext to a non-local host is refused; a 4xx greeting is connection_failed; a hung server is timeout", async () => {
  const plain = createFakeSmtp({ credentials: creds });
  assert.deepEqual(await smtpVerifyLogin(plain.connector, { ...config, security: "none" }, creds.username, creds.password), { ok: false, reason: "connection_failed" });
  assert.equal(plain.log.commands.length, 0);

  const busy = createFakeSmtp({ greeting: "421 4.3.2 Service not available" });
  assert.deepEqual(await smtpVerifyLogin(busy.connector, config, creds.username, creds.password), { ok: false, reason: "connection_failed" });

  const hung = createFakeSmtp({ silent: true });
  assert.deepEqual(await smtpVerifyLogin(hung.connector, { ...config, timeoutMs: 50 }, creds.username, creds.password), { ok: false, reason: "timeout" });
});

test("the password never appears in the result, even when the server echoes it back in its rejection", async () => {
  const { connector } = createFakeSmtp({ authReply: "535 5.7.8 bad password real-pw" });
  const r = await smtpVerifyLogin(connector, config, creds.username, creds.password);
  assert.equal(JSON.stringify(r).includes("real-pw"), false);
});

test("smtpSend is unchanged by the shared-handshake refactor: still authenticates with the CONFIG's credentials", async () => {
  const { connector, log } = createFakeSmtp({ credentials: { username: "ana@acme.ph", password: "outbound-pw" } });
  const r = await smtpSend(connector, config, { from: "ana@acme.ph", recipients: ["x@example.com"] }, "Subject: t\r\n\r\nhi\r\n");
  assert.equal(r.code, 250);
  assert.deepEqual(log.commands.map((c) => c.split(" ")[0]), ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
});
