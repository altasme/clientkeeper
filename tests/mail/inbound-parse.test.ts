import { test } from "node:test";
import assert from "node:assert/strict";
import PostalMime from "../../mail-worker/node_modules/postal-mime/dist/esm/postal-mime.js";
import { attachmentFilename, computeDedupeKey, isLikelyJunk, normalizeParsed } from "@altasme/webmail-kit/worker/parse";

const RAW = [
  "Return-Path: <sender@client.example>",
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=client.example; spf=pass; dmarc=pass",
  'From: "Client, Big" <Sender@Client.example>',
  "To: Altaventures <hello@altasme.com>, other@client.example",
  "Cc: =?UTF-8?B?Sm9zw6k=?= <jose@client.example>, undisclosed-recipients:;",
  "Reply-To: billing@client.example",
  "Subject: =?UTF-8?Q?Quotation_=E2=82=B1599?=",
  "Message-ID: <MSG-1@Client.example>",
  "In-Reply-To: <abc@altasme.com>",
  "References: <root@altasme.com> <abc@altasme.com>",
  "Date: Tue, 24 Nov 2026 09:00:00 +0800",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: multipart/related; boundary="b2"',
  "",
  "--b2",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Hello <b>team</b><img src="cid:img1@x"></p><script>alert(1)</script>',
  "--b2",
  "Content-Type: image/png",
  "Content-ID: <img1@x>",
  "Content-Disposition: inline",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--b2--",
  "--b1",
  "Content-Type: application/pdf",
  'Content-Disposition: attachment; filename="quote.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--b1--",
  "",
].join("\r\n");

test("normalizes a real multipart message", async () => {
  const parsed = await PostalMime.parse(RAW);
  const n = normalizeParsed(parsed, "bounce@client.example");
  assert.deepEqual(n.from, { name: "Client, Big", email: "sender@client.example" });
  assert.deepEqual(n.to.map((a) => a.email), ["hello@altasme.com", "other@client.example"]);
  assert.deepEqual(n.cc, [{ name: "José", email: "jose@client.example" }]);
  assert.equal(n.replyTo[0]?.email, "billing@client.example");
  assert.equal(n.subject, "Quotation ₱599");
  assert.equal(n.messageIdHeader, "<msg-1@client.example>");
  assert.match(n.text, /Hello team/);
  assert.equal(n.likelyJunk, false);
  assert.equal(parsed.attachments.length, 2);
  assert.equal(await computeDedupeKey(n), "mid:msg-1@client.example");
});

test("dedupe key falls back to a stable hash without Message-ID", async () => {
  const noId = RAW.replace("Message-ID: <MSG-1@Client.example>\r\n", "");
  const a = normalizeParsed(await PostalMime.parse(noId), "x@y.com");
  const b = normalizeParsed(await PostalMime.parse(noId), "x@y.com");
  const ka = await computeDedupeKey(a);
  assert.match(ka, /^hash:[0-9a-f]{64}$/);
  assert.equal(ka, await computeDedupeKey(b));
});

test("junk heuristic only on DMARC fail", () => {
  assert.equal(isLikelyJunk("mx; spf=fail; dkim=pass; dmarc=pass"), false);
  assert.equal(isLikelyJunk("mx; spf=fail; dkim=fail; dmarc=fail (p=reject)"), true);
  assert.equal(isLikelyJunk(null), false);
});

test("falls back to envelope sender when From is missing/invalid", async () => {
  const parsed = await PostalMime.parse("Subject: x\r\n\r\nbody");
  assert.equal(normalizeParsed(parsed, "Env@Sender.com").from.email, "env@sender.com");
  assert.equal(attachmentFilename(null, "application/pdf", 0), "attachment-1.pdf");
});
