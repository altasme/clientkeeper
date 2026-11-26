// POST /api/mail-client/send -- { mode, to, cc, bcc, subject, html, idempotencyKey, sourceMessageId? }
// Sends from the signed-in mailbox only. The real `cloudflare:sockets`
// transport is bound here; see functions/_lib/mailClient/routes.ts.

import { cloudflareSmtpTransport } from "@altasme/webmail-kit/smtpTransport";
import { sendRoute } from "../../_lib/mailClient/routes";

export const onRequestPost = sendRoute(cloudflareSmtpTransport);
