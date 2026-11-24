// Plain-text helpers: HTML -> text (for snippets, search indexing and the
// text/plain alternative part of outbound mail), subject normalization,
// HTML escaping. Regex-based on purpose: this never renders anything, it
// only derives text, so it doesn't need to be a real HTML parser -- the
// security-relevant HTML handling lives in sanitize.ts (HTMLRewriter).

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|title)[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|table)\s*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function makeSnippet(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

const PREFIX_RE = /^\s*((re|fw|fwd|aw|sv|antw)(\[\d+\])?\s*:\s*)+/i;

/** "Re: RE: Fwd: Hello" -> "Hello". Used for display/grouping only, never as the threading key. */
export function stripSubjectPrefixes(subject: string): string {
  return subject.replace(PREFIX_RE, "").trim();
}

export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^\s*re\s*:/i.test(s) ? s : `Re: ${s || "(no subject)"}`;
}

export function forwardSubject(subject: string): string {
  const s = subject.trim();
  return /^\s*(fw|fwd)\s*:/i.test(s) ? s : `Fwd: ${s || "(no subject)"}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
