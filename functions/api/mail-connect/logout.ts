// POST /api/mail-connect/logout -- clears the Webmail Connect session
// cookie. Needs no valid session (an expired cookie should still be
// clearable). Touches only ck_mail_connect_session, never ck_session or
// ck_mail_client_session.

import { jsonResponse } from "@altasme/webmail-kit/http";
import { clearMailConnectSessionCookie } from "../../_lib/mailConnect/session";

export const onRequestPost: PagesFunction = async () => jsonResponse(200, { ok: true }, { "Set-Cookie": clearMailConnectSessionCookie() });
