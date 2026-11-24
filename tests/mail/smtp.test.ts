import { test } from "node:test";
import assert from "node:assert/strict";
import { dotStuff, smtpSend, SmtpError, type SmtpConfig } from "@altasme/webmail-kit/smtp";
import { createFakeSmtp } from "./fakeSmtp";

const base: SmtpConfig = { host: "smtp.fake.test", port: 465, security: "tls", username: "user@fake.test", password: "s3cret", clientName: "altasme.com" };
const env = { from: "hello@altasme.com", recipients: ["a@example.com", "b@example.com"] };
const msg = "From: hello@altasme.com\r\nTo: a@example.com\r\nSubject: Hi\r\n\r\nHello\r\n.leading dot line\r\n";

test("implicit TLS + AUTH PLAIN + full transaction", async () => {
  const { connector, log } = createFakeSmtp();
  const r = await smtpSend(connector, base, env, msg);
  assert.equal(r.code, 250);
  assert.match(r.response, /queued as FAKE123/);
  assert.deepEqual(
    log.commands.map((c) => c.split(" ")[0]),
    ["EHLO", "AUTH", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]
  );
  assert.equal(log.commands[0], "EHLO altasme.com");
  assert.equal(log.commands[1], `AUTH PLAIN ${Buffer.from("\0user@fake.test\0s3cret").toString("base64")}`);
  assert.match(log.commands[2]!, /^MAIL FROM:<hello@altasme\.com> SIZE=\d+$/);
  assert.equal(log.commands[3], "RCPT TO:<a@example.com>");
  // dot-stuffing: the server sees the doubled dot on the wire
  assert.match(log.data, /\r\n\.\.leading dot line\r\n/);
});

test("STARTTLS upgrades and re-EHLOs before AUTH", async () => {
  const { connector, log } = createFakeSmtp();
  await smtpSend(connector, { ...base, port: 587, security: "starttls" }, env, msg);
  assert.equal(log.tlsUpgraded, true);
  assert.deepEqual(log.commands.slice(0, 4).map((c) => c.split(" ")[0]), ["EHLO", "STARTTLS", "EHLO", "AUTH"]);
});

test("falls back to AUTH LOGIN when PLAIN isn't offered", async () => {
  const { connector, log } = createFakeSmtp({ authMechanisms: "LOGIN" });
  await smtpSend(connector, base, env, msg);
  assert.equal(log.commands[1], "AUTH LOGIN");
  assert.equal(log.commands[2], Buffer.from("user@fake.test").toString("base64"));
  assert.equal(log.commands[3], Buffer.from("s3cret").toString("base64"));
});

test("4xx on RCPT is a transient failure", async () => {
  const { connector } = createFakeSmtp({ rcptReply: () => "451 4.7.1 Try again later" });
  await assert.rejects(smtpSend(connector, base, env, msg), (e: unknown) => e instanceof SmtpError && e.kind === "transient" && e.code === 451 && e.stage === "RCPT TO");
});

test("5xx on RCPT is permanent, never retried", async () => {
  const { connector } = createFakeSmtp({ rcptReply: (r) => (r.startsWith("b@") ? "550 5.1.1 No such user" : "250 Ok") });
  await assert.rejects(smtpSend(connector, base, env, msg), (e: unknown) => e instanceof SmtpError && e.kind === "permanent" && e.code === 550);
});

test("auth failure is permanent and does not echo credentials", async () => {
  const { connector } = createFakeSmtp({ authReply: "535 5.7.8 Authentication credentials invalid s3cret" });
  await assert.rejects(smtpSend(connector, base, env, msg), (e: unknown) => {
    assert.ok(e instanceof SmtpError);
    assert.equal(e.kind, "permanent");
    assert.equal(e.message.includes("s3cret"), false);
    return true;
  });
});

test("connection lost after end-of-data is UNKNOWN (no auto-retry, could duplicate)", async () => {
  const { connector } = createFakeSmtp({ dropAfterData: true });
  await assert.rejects(smtpSend(connector, base, env, msg), (e: unknown) => e instanceof SmtpError && e.kind === "unknown");
});

test("4xx after DATA is transient (server explicitly did not accept)", async () => {
  const { connector } = createFakeSmtp({ dataReply: "452 4.3.1 Insufficient storage" });
  await assert.rejects(smtpSend(connector, base, env, msg), (e: unknown) => e instanceof SmtpError && e.kind === "transient" && e.code === 452);
});

test("refuses plaintext SMTP to a non-local host", async () => {
  const { connector } = createFakeSmtp();
  await assert.rejects(smtpSend(connector, { ...base, security: "none" }, env, msg), (e: unknown) => e instanceof SmtpError && e.stage === "config");
});

test("rejects CR/LF in envelope addresses (command injection)", async () => {
  const { connector } = createFakeSmtp();
  await assert.rejects(smtpSend(connector, base, { from: "a@b.com>\r\nRCPT TO:<x@y.com", recipients: ["a@example.com"] }, msg), SmtpError);
});

test("dotStuff normalizes newlines and doubles leading dots", () => {
  assert.equal(dotStuff(".a\n..b\nc"), "..a\r\n...b\r\nc\r\n");
});
