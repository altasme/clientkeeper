// POST /api/mail-client/logout -- clears the mailbox-owner session cookie.
// Needs no valid session (an expired cookie should still be clearable),
// same as /api/auth-logout for staff. Touches only ck_mail_client_session,
// never the staff ck_session.

import { jsonResponse } from "@altasme/webmail-kit/http";
import { clearMailClientSessionCookie } from "../../_lib/mailClient/session";

export const onRequestPost: PagesFunction = async () => jsonResponse(200, { ok: true }, { "Set-Cookie": clearMailClientSessionCookie() });
