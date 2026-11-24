import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplyHeaders, computeReplyRecipients, normalizeMessageId, parseMessageIdList, threadLookupIds } from "@altasme/webmail-kit/threading";
import { forwardSubject, replySubject, stripSubjectPrefixes } from "@altasme/webmail-kit/text";

test("normalizes message ids", () => {
  assert.equal(normalizeMessageId(" <ABC.123@Mail.Example.com> "), "abc.123@mail.example.com");
  assert.deepEqual(parseMessageIdList("<a@x> <b@x>\r\n <a@x>"), ["a@x", "b@x"]);
});

test("reply headers chain References + parent Message-ID", () => {
  const h = buildReplyHeaders({ message_id_header: "<c@x>", references_header: "<a@x> <b@x>", in_reply_to: "<b@x>" });
  assert.equal(h.inReplyTo, "<c@x>");
  assert.equal(h.references, "<a@x> <b@x> <c@x>");
  const first = buildReplyHeaders({ message_id_header: "<a@x>", references_header: null, in_reply_to: null });
  assert.equal(first.references, "<a@x>");
});

test("thread lookup prefers In-Reply-To then newest reference", () => {
  assert.deepEqual(threadLookupIds("<c@x>", "<a@x> <b@x> <c@x>"), ["c@x", "b@x", "a@x"]);
});

test("subject prefixes only added once", () => {
  assert.equal(replySubject("Re: Hello"), "Re: Hello");
  assert.equal(replySubject("Hello"), "Re: Hello");
  assert.equal(forwardSubject("FWD: x"), "FWD: x");
  assert.equal(stripSubjectPrefixes("Re: RE: Fwd: Quote"), "Quote");
});

const source = {
  direction: "inbound" as const,
  from: { name: "Client", email: "client@biz.com" },
  replyTo: [] as { name: string | null; email: string }[],
  to: [
    { name: null, email: "hello@altasme.com" },
    { name: "Partner", email: "partner@biz.com" },
  ],
  cc: [
    { name: null, email: "support@altasme.com" },
    { name: null, email: "acct@biz.com" },
    { name: null, email: "no-reply@biz.com" },
    { name: null, email: "client@biz.com" },
  ],
};

test("reply goes to Reply-To when present, else sender", () => {
  assert.deepEqual(computeReplyRecipients(source, "reply", "hello@altasme.com").to, [{ name: "Client", email: "client@biz.com" }]);
  const withRt = { ...source, replyTo: [{ name: null, email: "billing@biz.com" }] };
  assert.deepEqual(computeReplyRecipients(withRt, "reply", "hello@altasme.com").to, [{ name: null, email: "billing@biz.com" }]);
});

test("reply-all excludes own identities, duplicates and automated senders", () => {
  const r = computeReplyRecipients(source, "reply_all", "hello@altasme.com", ["support@altasme.com"]);
  assert.deepEqual(r.to.map((a) => a.email), ["client@biz.com", "partner@biz.com"]);
  assert.deepEqual(r.cc.map((a) => a.email), ["acct@biz.com"]);
});

test("replying to our own sent message goes back to its recipients", () => {
  const sent = { direction: "outbound" as const, from: { name: null, email: "hello@altasme.com" }, replyTo: [], to: [{ name: null, email: "client@biz.com" }], cc: [] };
  assert.deepEqual(computeReplyRecipients(sent, "reply", "hello@altasme.com").to.map((a) => a.email), ["client@biz.com"]);
});
