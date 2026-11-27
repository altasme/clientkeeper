// POST /api/mail-connect/send -- { mailboxId, mode, to, cc, bcc, subject, html, idempotencyKey, sourceMessageId? }
// Sends from mailboxId only, with the send permission. The real
// `cloudflare:sockets` transport is bound here; see
// functions/_lib/mailConnect/routes.ts.

import { cloudflareSmtpTransport } from "@altasme/webmail-kit/smtpTransport";
import { sendRoute } from "../../_lib/mailConnect/routes";

export const onRequestPost = sendRoute(cloudflareSmtpTransport);
