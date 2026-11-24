import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAddresses, encodeHeaderValue, formatAddress, isAutomatedAddress, isValidEmail, parseAddress, parseAddressList, stripPlusTag } from "@altasme/webmail-kit/address";

test("parses names, angle addresses, quoted commas", () => {
  const r = parseAddressList(`"Doe, Jane" <Jane@Example.com>, bob@x.org; not-an-email,  Carl <carl@y.co>\nlast@z.io`);
  assert.deepEqual(r.valid, [
    { name: "Doe, Jane", email: "jane@example.com" },
    { name: null, email: "bob@x.org" },
    { name: "Carl", email: "carl@y.co" },
    { name: null, email: "last@z.io" },
  ]);
  assert.deepEqual(r.invalid, ["not-an-email"]);
});

test("rejects header-injection attempts", () => {
  assert.equal(isValidEmail("a@b.com\r\nBcc: x@y.com"), false);
  assert.equal(parseAddress("Evil\r\nBcc: x@y.com <a@b.com>"), null);
  assert.equal(isValidEmail("a..b@c.com"), false);
  assert.equal(isValidEmail("a@localhost"), false);
});

test("formats display names safely (RFC 2047 / quoting)", () => {
  assert.equal(formatAddress({ name: "Jane", email: "j@x.com" }), "Jane <j@x.com>");
  assert.equal(formatAddress({ name: "Doe, Jane", email: "j@x.com" }), `"Doe, Jane" <j@x.com>`);
  assert.match(formatAddress({ name: "José Ñ", email: "j@x.com" }), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <j@x\.com>$/);
  assert.equal(formatAddress({ name: "A\r\nBcc: z@z.com", email: "j@x.com" }).includes("\n"), false);
});

test("encodes non-ASCII subjects", () => {
  assert.equal(encodeHeaderValue("Hello"), "Hello");
  const enc = encodeHeaderValue("Salamat po 🙏 — ₱599");
  assert.match(enc, /^=\?UTF-8\?B\?/);
  for (const word of enc.split(" ")) assert.ok(word.length <= 75);
});

test("plus tags, dedupe, automated addresses", () => {
  assert.equal(stripPlusTag("Support+Inv123@AltaSME.com"), "support@altasme.com");
  assert.deepEqual(dedupeAddresses([{ name: "A", email: "a@x.com" }, { name: null, email: "A@X.com" }, { name: null, email: "me@x.com" }], ["me@x.com"]), [{ name: "A", email: "a@x.com" }]);
  assert.equal(isAutomatedAddress("no-reply@x.com"), true);
  assert.equal(isAutomatedAddress("mailer-daemon@x.com"), true);
  assert.equal(isAutomatedAddress("list-request@x.com"), true);
  assert.equal(isAutomatedAddress("jane@x.com"), false);
});
