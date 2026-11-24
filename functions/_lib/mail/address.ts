// Email address parsing, normalization and validation for the webmail
// module. Pure functions, no Workers APIs, so they're unit-tested under
// Node (tests/mail/address.test.ts).
//
// Security note: every address and display name that ends up in an SMTP
// command or a MIME header passes through here first. CR/LF anywhere is
// rejected outright (header injection), addresses are restricted to a
// conservative character set, and display names are emitted as RFC 2047
// encoded-words when they contain anything outside printable ASCII or any
// RFC 5322 "special" character, so a crafted name can never terminate a
// header or smuggle in a second one.

export interface MailAddress {
  name: string | null;
  email: string;
}

// Conservative: local part of common atext characters + dots, domain of
// labels. Deliberately rejects quoted local parts and IP-literal domains --
// valid per RFC 5321 but never needed by a business mailbox, and both are
// common vectors for parser confusion.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (hasLineBreak(email)) return false;
  const e = email.trim();
  if (!EMAIL_RE.test(e)) return false;
  const local = e.split("@")[0]!;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return true;
}

/** Strips a +tag from the local part: support+abc@x.com -> support@x.com. */
export function stripPlusTag(email: string): string {
  const [local, domain] = normalizeEmail(email).split("@");
  if (!local || !domain) return normalizeEmail(email);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}@${domain}`;
}

function cleanName(name: string): string | null {
  const n = name
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\\(.)/g, "$1")
    .trim();
  return n ? n.slice(0, 200) : null;
}

/** Parses a single "Name <a@b.c>" / "<a@b.c>" / "a@b.c" token. Returns null if invalid. */
export function parseAddress(input: string): MailAddress | null {
  if (hasLineBreak(input)) return null;
  const s = input.trim();
  if (!s) return null;
  const angle = s.match(/^(.*)<([^<>]+)>\s*$/);
  if (angle) {
    const email = angle[2]!.trim();
    if (!isValidEmail(email)) return null;
    return { name: cleanName(angle[1] ?? ""), email: normalizeEmail(email) };
  }
  if (!isValidEmail(s)) return null;
  return { name: null, email: normalizeEmail(s) };
}

/**
 * Splits a pasted/typed recipient string on commas, semicolons and
 * newlines -- but not on commas inside a quoted display name
 * ("Doe, Jane" <jane@x.com>). Returns valid addresses and the raw tokens
 * that failed to parse, so the UI can show them as inline errors.
 */
export function parseAddressList(input: string): { valid: MailAddress[]; invalid: string[] } {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of input) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "<") inAngle = true;
    if (!inQuote && ch === ">") inAngle = false;
    if (!inQuote && !inAngle && (ch === "," || ch === ";" || ch === "\n" || ch === "\r")) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  tokens.push(current);
  const valid: MailAddress[] = [];
  const invalid: string[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const parsed = parseAddress(t);
    if (parsed) valid.push(parsed);
    else invalid.push(t);
  }
  return { valid, invalid };
}

/** Removes duplicates by normalized email, keeping the first occurrence (and its name). */
export function dedupeAddresses(list: MailAddress[], exclude: Iterable<string> = []): MailAddress[] {
  const seen = new Set<string>([...exclude].map(normalizeEmail));
  const out: MailAddress[] = [];
  for (const a of list) {
    const key = normalizeEmail(a.email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name, email: key });
  }
  return out;
}

/** Validates a JSON-ish array of {name?, email} coming from an API body. */
export function coerceAddressArray(value: unknown, max = 100): { valid: MailAddress[]; invalid: string[] } {
  const valid: MailAddress[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(value)) return { valid, invalid };
  for (const item of value.slice(0, max)) {
    if (typeof item === "string") {
      const p = parseAddress(item);
      if (p) valid.push(p);
      else invalid.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const email = typeof o.email === "string" ? o.email : "";
      const name = typeof o.name === "string" ? o.name : "";
      if (isValidEmail(email) && !hasLineBreak(name)) valid.push({ name: cleanName(name), email: normalizeEmail(email) });
      else invalid.push(email || String(name));
    }
  }
  return { valid, invalid };
}

// Addresses that should never receive a Reply-All copy: automated senders
// and list robots. Conservative pattern match on the local part.
const AUTOMATED_LOCAL_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|list-?(?:request|owner)|.*-(?:request|owner|bounces))(\+.*)?$/i;

export function isAutomatedAddress(email: string): boolean {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  return AUTOMATED_LOCAL_RE.test(local);
}

// ---------- header formatting ----------

const SPECIALS_RE = /[()<>[\]:;@\\,."]/;

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * RFC 2047 "B" encoded-word(s) for a header value. Splits into multiple
 * encoded-words so no single word exceeds the 75-character limit, without
 * splitting a UTF-8 multi-byte sequence across words.
 */
export function encodeWord(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    const candidate = chunk + ch;
    if (new TextEncoder().encode(candidate).length > 45) {
      words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
      chunk = ch;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
  return words.join(" ");
}

/** Header-safe value for unstructured headers such as Subject. */
export function encodeHeaderValue(value: string): string {
  const v = value.replace(/[\r\n]+/g, " ");
  if (isPrintableAscii(v) && v.length <= 900) return v;
  return encodeWord(v);
}

export function formatAddress(addr: MailAddress): string {
  if (hasLineBreak(addr.email) || !isValidEmail(addr.email)) throw new Error("Invalid address");
  const name = addr.name?.replace(/[\r\n]+/g, " ").trim();
  if (!name) return addr.email;
  if (!isPrintableAscii(name)) return `${encodeWord(name)} <${addr.email}>`;
  if (SPECIALS_RE.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${addr.email}>`;
  return `${name} <${addr.email}>`;
}

export function formatAddressList(list: MailAddress[]): string {
  return list.map(formatAddress).join(", ");
}
