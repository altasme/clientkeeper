// POST /api/mail-client/login -- { email, password }
// A mailbox owner signs in to their own client-hosted mailbox. Unlike every
// /api/app/* route, this is reachable without a session (it's how one is
// created). Logic, rate limiting and the eligibility rule: see
// functions/_lib/mailClient/login.ts and CLAUDE.md §36. The real SMTP AUTH
// check (`cloudflare:sockets`) is bound here.

import { verifySmtpLogin } from "@altasme/webmail-kit/smtpTransport";
import { handleMailClientLogin } from "../../_lib/mailClient/login";
import type { MailClientEnv } from "../../_lib/mailClient/handler";

export const onRequestPost: PagesFunction<MailClientEnv> = (ctx) => handleMailClientLogin(ctx, { verify: verifySmtpLogin });
