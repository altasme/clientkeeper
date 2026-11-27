// GET /api/mail-connect/me -- the session's live mailbox grants (with
// permissions), the panel's name and its "back" URL. 401 when not signed
// in. See functions/_lib/mailConnect/routes.ts.

import { me } from "../../_lib/mailConnect/routes";

export const onRequestGet = me;
