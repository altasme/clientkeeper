// GET /api/mail-client/me -- the signed-in mailbox (address, display name,
// whether it can send). 401 when not signed in.

import { me } from "../../_lib/mailClient/routes";

export const onRequestGet = me;
