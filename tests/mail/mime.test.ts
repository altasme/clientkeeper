import { test } from "node:test";
import assert from "node:assert/strict";
import PostalMime from "../../mail-worker/node_modules/postal-mime/dist/esm/postal-mime.js";
import { buildMimeMessage, quotedPrintable } from "@altasme/webmail-kit/mime";

test("quoted-printable keeps lines <= 76 and encodes UTF-8", () => {
  const qp = quotedPrintable("Salamat po ₱599 " + "x".repeat(200) + "\nnext line=");
  for (const line of qp.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.match(qp, /=E2=82=B1/);
  assert.match(qp, /next line=3D$/);
});

test("built message round-trips through a real MIME parser", async () => {
  const pdf = new Uint8Array(3000).map((_, i) => i % 256);
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const raw = buildMimeMessage({
    from: { name: "Altaventures Support", email: "support@altasme.com" },
    to: [{ name: "Doe, Jane", email: "jane@example.com" }],
    cc: [{ name: "José", email: "jose@example.com" }],
    replyTo: { name: null, email: "hello@altasme.com" },
    subject: "Re: Your quote ₱599 ✓",
    text: "Hello Jane,\n.dot line\nThanks",
    html: "<p>Hello Jane,</p><p>Thanks <img src=\"cid:logo1\"></p>",
    messageId: "<abc-123@altasme.com>",
    inReplyTo: "<orig@example.com>",
    references: "<root@example.com> <orig@example.com>",
    date: new Date("2026-11-24T10:00:00Z"),
    attachments: [
      { filename: "Quotation ñ.pdf", mimeType: "application/pdf", content: pdf },
      { filename: "logo.png", mimeType: "image/png", content: png, contentId: "logo1", inline: true },
    ],
  });
  assert.equal(/\r\n/.test(raw) && !/[^\r]\n/.test(raw), true, "CRLF line endings only");
  assert.equal(/^Bcc:/im.test(raw), false);
  const parsed = await PostalMime.parse(raw);
  assert.equal(parsed.subject, "Re: Your quote ₱599 ✓");
  assert.equal(parsed.messageId, "<abc-123@altasme.com>");
  assert.equal(parsed.inReplyTo, "<orig@example.com>");
  assert.equal(parsed.references, "<root@example.com> <orig@example.com>");
  assert.deepEqual(parsed.from, { name: "Altaventures Support", address: "support@altasme.com" });
  assert.deepEqual(parsed.to, [{ name: "Doe, Jane", address: "jane@example.com" }]);
  assert.deepEqual(parsed.cc, [{ name: "José", address: "jose@example.com" }]);
  assert.equal(parsed.replyTo?.[0]?.address, "hello@altasme.com");
  assert.equal(parsed.text?.trim(), "Hello Jane,\n.dot line\nThanks");
  assert.match(parsed.html ?? "", /cid:logo1/);
  const att = parsed.attachments.find((a) => a.mimeType === "application/pdf")!;
  assert.equal(att.filename, "Quotation ñ.pdf");
  assert.deepEqual(new Uint8Array(att.content as ArrayBuffer), pdf);
  const inline = parsed.attachments.find((a) => a.mimeType === "image/png")!;
  assert.equal(inline.contentId, "<logo1>");
  assert.deepEqual(new Uint8Array(inline.content as ArrayBuffer), png);
});

test("refuses header injection through threading headers", () => {
  assert.throws(() =>
    buildMimeMessage({ from: { name: null, email: "a@altasme.com" }, to: [{ name: null, email: "b@x.com" }], cc: [], subject: "x", text: "", html: "", messageId: "<a@b>\r\nBcc: z@z.com" })
  );
});
