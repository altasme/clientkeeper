// Shared Resend email helper (functions/_lib/email.ts).
//
// Duplicated from clienthub's own copy rather than cross-repo imported
// (see CLAUDE.md's "reuses the pattern, not the code" convention already
// used for lib/contact.ts). Cloudflare Workers isn't a Node runtime, so
// this calls Resend's REST API directly via fetch().
//
// This is the email the "Resend Account Setup Email" button on a client's
// detail page sends [2026-09-07 fix]. It used to call WorkOS's own
// sendInvitation() — that stopped being how account creation works at all
// once clienthub's ganap webhook was changed to no longer auto-send WorkOS
// invitations (two concurrent "ways in" confused a real client). This
// button now re-sends the same kind of account-signup nudge as an email,
// pointing at the one real entry point (ACCOUNT_SIGNUP_URL).

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface SendEmailEnv {
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
}

export async function sendEmail(
  env: SendEmailEnv,
  { to, subject, html }: { to: string; subject: string; html: string }
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [to], subject, html }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Resend failed: ${response.status} ${text}`);
  }
}

export const ACCOUNT_SIGNUP_URL = "https://account.altasme.com/api/auth-start?intent=signup";

export function accountReminderEmail(params: { clientName: string; businessName: string }): {
  subject: string;
  html: string;
} {
  const { clientName, businessName } = params;
  const greetingName = clientName || businessName || "there";

  const html = `
    <p>Hi ${escapeHtml(greetingName)},</p>
    <p>Just a reminder to create your Altaventures account for <strong>${escapeHtml(businessName)}</strong> so you can track your project's progress.</p>
    <p><a href="${ACCOUNT_SIGNUP_URL}">Click here to create your account</a>.</p>
  `;

  return { subject: `Complete Your Account Setup — ${businessName || "Altaventures"}`, html };
}
