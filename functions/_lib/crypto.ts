// Shared HMAC helpers, copied verbatim from the clienthub repo's identical
// module (functions/_lib/crypto.ts there) rather than shared as a package —
// see clienthub/CLAUDE.md and this repo's own CLAUDE.md §0 for why the two
// apps' server layers are deliberately independent (a bug in one has no
// code path into the other). Uses the Web Crypto API since Cloudflare
// Workers isn't a Node runtime.
//
// Lives under functions/_lib/ (leading underscore) so Cloudflare Pages
// Functions' file-based router excludes it from routing.
//
// Only the two generic primitives are needed here (this app's own session
// cookie signing) — WorkOS webhook verification isn't, since payment/
// invitation webhooks live entirely in clienthub per CLAUDE.md §0.

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
