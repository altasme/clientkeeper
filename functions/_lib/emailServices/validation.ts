// Input validation for email services. Deliberately conservative: these
// are OUR rules. The provider may be stricter, in which case its
// invalid_input error is surfaced as-is.

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (d.startsWith("www.")) d = d.slice(4);
  if (d.length < 3 || d.length > 253) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => DOMAIN_LABEL.test(l))) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]!)) return null;
  return d;
}

// Lowercase dot-atom subset most hosting providers accept: letters,
// digits, . _ - +, no leading/trailing/double dots, max 64 chars.
export function normalizeLocalPart(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const l = raw.trim().toLowerCase();
  if (l.length < 1 || l.length > 64) return null;
  if (!/^[a-z0-9._+-]+$/.test(l)) return null;
  if (l.startsWith(".") || l.endsWith(".") || l.includes("..")) return null;
  return l;
}

export function validateMailboxPassword(raw: unknown): { ok: true; password: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "A password is required." };
  if (raw.length < 10) return { ok: false, error: "Password must be at least 10 characters." };
  if (raw.length > 128) return { ok: false, error: "Password must be at most 128 characters." };
  if (/[\r\n\0]/.test(raw)) return { ok: false, error: "Password contains invalid characters." };
  if (!/[a-zA-Z]/.test(raw) || !/[0-9]/.test(raw)) return { ok: false, error: "Password must contain letters and numbers." };
  return { ok: true, password: raw };
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

// Accepts "YYYY-MM-DD" (treated as end of that day, UTC) or a full ISO
// timestamp; returns a full ISO string.
export function normalizeDateInput(value: unknown): string | null {
  if (!isIsoDate(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T23:59:59.000Z`).toISOString();
  return new Date(value).toISOString();
}

export function cleanText(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}
