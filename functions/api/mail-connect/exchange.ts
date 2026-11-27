// GET /api/mail-connect/exchange?code=... -- a client admin panel's
// single-use launch code becomes a Webmail Connect session, then a
// redirect to /mail/connect. Reachable without a session (it's how one is
// created). Logic and single-use guarantee: functions/_lib/mailConnect/exchange.ts.

import { handleExchange } from "../../_lib/mailConnect/exchange";
import type { MailConnectEnv } from "../../_lib/mailConnect/handler";

export const onRequestGet: PagesFunction<MailConnectEnv> = (ctx) => handleExchange(ctx);
