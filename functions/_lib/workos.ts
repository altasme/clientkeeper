// Shared WorkOS User Management API helpers, called via plain fetch() — no
// Node SDK, since Cloudflare Workers isn't a Node runtime. Copied from
// clienthub's identical module rather than shared as a package (see this
// repo's CLAUDE.md §0). API shape verified against workos-node's own
// source on GitHub (workos.com/api.workos.com are blocked by this
// sandbox's egress proxy) — see clienthub/CLAUDE.md §1.3/§1.4 for the full
// reasoning.
//
// Lives under functions/_lib/ (leading underscore) so Cloudflare Pages
// Functions' file-based router excludes it from routing.

const WORKOS_API_BASE = "https://api.workos.com";

export interface WorkosUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export interface WorkosInvitation {
  id: string;
  email: string;
  state: "pending" | "accepted" | "expired" | "revoked";
  token: string;
  accept_invitation_url: string;
  expires_at: string;
}

/**
 * Invites an email address to sign up via AuthKit. Used here only for the
 * staff-triggered "resend invite" action on a paid-but-no-account client
 * (functions/api/app/clients/[id]/resend-invite.ts) — the same call
 * clienthub's ganap webhook makes on first issuance. No
 * organization_id/role_slug: neither app uses WorkOS Organizations for role
 * management (roles live in the shared D1 `users` table instead).
 */
export async function sendInvitation(apiKey: string, email: string): Promise<WorkosInvitation> {
  const response = await fetch(`${WORKOS_API_BASE}/user_management/invitations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WorkOS sendInvitation failed: ${response.status} ${text}`);
  }

  return (await response.json()) as WorkosInvitation;
}

/**
 * Exchanges an OAuth authorization_code (from the AuthKit hosted login
 * redirect) for the authenticated user. client_secret is the WorkOS API
 * key — server-only, must never reach the client.
 */
export async function exchangeAuthorizationCode(
  apiKey: string,
  clientId: string,
  code: string
): Promise<WorkosUser> {
  const response = await fetch(`${WORKOS_API_BASE}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: apiKey,
      code,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WorkOS authenticate failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { user?: WorkosUser };
  if (!data.user) throw new Error("WorkOS authenticate response missing user");
  return data.user;
}
