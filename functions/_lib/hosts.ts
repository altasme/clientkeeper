// Which public hostnames this Pages project answers on, and where each one
// lands after login (CLAUDE.md §34.6).
//
// The session cookie is host-only (no Domain= attribute, see session.ts),
// so a login must complete on the SAME hostname the person started on,
// or the cookie is set on the wrong host and they appear logged out.
// auth-start/auth-callback therefore derive the WorkOS redirect_uri and the
// post-login landing URL from the request's own host, but only for hosts
// listed here. Anything else (a *.pages.dev preview, a typo'd custom
// domain) falls back to the canonical clientkeeper.altasme.com behavior,
// exactly as before this file existed, so the redirect_uri can never be
// steered to an attacker-chosen host.
//
// mail.altasme.com is the planned friendly hostname for the /mail
// workspace (same app, same deployment). Before it is attached as a
// custom domain, its callback URL must also be added to the WorkOS
// dashboard's allowed redirect URIs, or WorkOS will reject the login.

export interface KnownHost {
  origin: string;
  homePath: string;
}

export const CANONICAL_HOST = "clientkeeper.altasme.com";

const KNOWN_HOSTS: Record<string, KnownHost> = {
  "clientkeeper.altasme.com": { origin: "https://clientkeeper.altasme.com", homePath: "/" },
  "mail.altasme.com": { origin: "https://mail.altasme.com", homePath: "/mail" },
};

export function resolveHost(requestUrl: string): KnownHost {
  let host = "";
  try {
    host = new URL(requestUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  return KNOWN_HOSTS[host] ?? KNOWN_HOSTS[CANONICAL_HOST]!;
}
