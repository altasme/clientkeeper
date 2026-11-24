// RFC 5322 / MIME message construction for outbound mail. Pure (no
// Workers APIs) so it's unit-tested under Node (tests/mail/mime.test.ts).
//
// Shape:
//   no attachments:          multipart/alternative { text/plain, text/html }
//   inline (cid:) images:    the html part becomes multipart/related { text/html, image... }
//   regular attachments:     multipart/mixed { <the above>, attachment... }
// Text parts are quoted-printable UTF-8 (readable, 7-bit safe, what spam
// filters expect for text); attachments are base64 wrapped at 76 columns.
// Every line ends in CRLF. Bcc is never written into the headers -- it
// only exists in the SMTP envelope (see send.ts).

import { encodeHeaderValue, formatAddress, formatAddressList, hasLineBreak, type MailAddress } from "./address";

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
  contentId?: string | null;
  inline?: boolean;
}

export interface MimeInput {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo?: MailAddress | null;
  subject: string;
  text: string;
  html: string;
  messageId: string; // with angle brackets
  inReplyTo?: string | null;
  references?: string | null;
  date?: Date;
  attachments?: MimeAttachment[];
}

const CRLF = "\r\n";

export function rfc2822Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())} +0000`;
}

function randomBoundary(tag: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `----=_${tag}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join(CRLF);
}

/** Quoted-printable (RFC 2045 §6.7) over UTF-8 bytes, CRLF hard line breaks, soft breaks at 76. */
export function quotedPrintable(text: string): string {
  const normalized = text.replace(/\r\n|\r|\n/g, "\n");
  const outLines: string[] = [];
  for (const line of normalized.split("\n")) {
    const bytes = new TextEncoder().encode(line);
    let out = "";
    let lineLen = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const isLast = i === bytes.length - 1;
      let enc: string;
      if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !isLast)) enc = String.fromCharCode(b);
      else enc = `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (lineLen + enc.length > 75) {
        out += `=${CRLF}`;
        lineLen = 0;
      }
      out += enc;
      lineLen += enc.length;
    }
    outLines.push(out);
  }
  return outLines.join(CRLF);
}

function encodeParam(name: string, value: string): string {
  const clean = value.replace(/[\r\n"\\]/g, "_");
  if (/^[\x20-\x7e]*$/.test(clean)) return `${name}="${clean}"`;
  const encoded = Array.from(new TextEncoder().encode(value), (b) =>
    /[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
  ).join("");
  return `${name}*=UTF-8''${encoded}`;
}

function safeMimeType(t: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(t) ? t.toLowerCase() : "application/octet-stream";
}

function textPart(contentType: string, body: string): string {
  return [`Content-Type: ${contentType}; charset=UTF-8`, "Content-Transfer-Encoding: quoted-printable", "", quotedPrintable(body)].join(CRLF);
}

function attachmentPart(a: MimeAttachment): string {
  const type = safeMimeType(a.mimeType);
  const headers = [`Content-Type: ${type}; ${encodeParam("name", a.filename)}`, "Content-Transfer-Encoding: base64"];
  if (a.inline && a.contentId && !hasLineBreak(a.contentId)) {
    headers.push(`Content-ID: <${a.contentId.replace(/[<>]/g, "")}>`);
    headers.push(`Content-Disposition: inline; ${encodeParam("filename", a.filename)}`);
  } else {
    headers.push(`Content-Disposition: attachment; ${encodeParam("filename", a.filename)}`);
  }
  return [...headers, "", wrap76(base64Encode(a.content))].join(CRLF);
}

function multipart(subtype: string, parts: string[]): string {
  const boundary = randomBoundary(subtype);
  return [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}${CRLF}${p}`), `--${boundary}--`, ""].join(
    CRLF
  );
}

function assertHeaderSafe(label: string, value: string | null | undefined) {
  if (value && hasLineBreak(value)) throw new Error(`Invalid ${label}`);
}

export function buildMimeMessage(input: MimeInput): string {
  assertHeaderSafe("Message-ID", input.messageId);
  assertHeaderSafe("In-Reply-To", input.inReplyTo);
  assertHeaderSafe("References", input.references);

  const attachments = input.attachments ?? [];
  const inline = attachments.filter((a) => a.inline && a.contentId);
  const regular = attachments.filter((a) => !(a.inline && a.contentId));

  const htmlPart = textPart("text/html", input.html);
  const htmlSection = inline.length ? multipart("related", [htmlPart, ...inline.map(attachmentPart)]) : htmlPart;
  const alternative = multipart("alternative", [textPart("text/plain", input.text), htmlSection]);
  const body = regular.length ? multipart("mixed", [alternative, ...regular.map(attachmentPart)]) : alternative;

  const headers = [
    `From: ${formatAddress(input.from)}`,
    input.to.length ? `To: ${formatAddressList(input.to)}` : null,
    input.cc.length ? `Cc: ${formatAddressList(input.cc)}` : null,
    input.replyTo ? `Reply-To: ${formatAddress(input.replyTo)}` : null,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${rfc2822Date(input.date ?? new Date())}`,
    `Message-ID: ${input.messageId}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
    input.references ? `References: ${input.references}` : null,
    "MIME-Version: 1.0",
  ].filter((h): h is string => h !== null);

  // `body` starts with its own Content-Type header line(s), so the message
  // headers and the top-level part headers form one header block.
  return `${headers.join(CRLF)}${CRLF}${body}`;
}
