// Display helpers for the webmail UI. The address parser is a small
// browser-side copy of functions/_lib/mail/address.ts's parseAddressList
// (same "duplicate the pattern, not the code" convention as the rest of
// this repo: src/ and functions/ are separate build targets). The server
// re-validates every address at send time regardless.

import type { Addr } from "./mailApi";

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isValidEmail(email: string): boolean {
  const e = email.trim();
  if (/[\r\n]/.test(e) || !EMAIL_RE.test(e)) return false;
  const local = e.split("@")[0]!;
  return !(local.startsWith(".") || local.endsWith(".") || local.includes(".."));
}

export interface RecipientToken extends Addr {
  valid: boolean;
}

export function parseRecipients(input: string): RecipientToken[] {
  const tokens: string[] = [];
  let cur = "";
  let q = false;
  let angle = false;
  for (const ch of input) {
    if (ch === '"') q = !q;
    if (!q && ch === "<") angle = true;
    if (!q && ch === ">") angle = false;
    if (!q && !angle && (ch === "," || ch === ";" || ch === "\n")) {
      tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  tokens.push(cur);
  const out: RecipientToken[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^(.*)<([^<>]+)>\s*$/);
    const email = (m ? m[2]! : t).trim();
    const name = m ? m[1]!.replace(/^["'\s]+|["'\s]+$/g, "").trim() || null : null;
    out.push({ name, email: isValidEmail(email) ? email.toLowerCase() : email, valid: isValidEmail(email) });
  }
  return out;
}

export function displayAddr(a: Addr): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function shortName(a: Addr): string {
  return a.name || a.email.split("@")[0] || a.email;
}

export function initials(a: Addr): string {
  const src = a.name || a.email;
  const parts = src.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

const TZ = "Asia/Manila";

export function formatListDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toLocaleDateString("en-US", { timeZone: TZ }) === now.toLocaleDateString("en-US", { timeZone: TZ });
  if (sameDay) return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const SEND_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  sending: "Sending…",
  sent: "Accepted by mail server",
  retry_scheduled: "Retry scheduled",
  failed: "Failed",
  received: "Received",
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function plainTextToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function htmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  return (div.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
