// POST /api/mail-connect/messages/:id/move -- { mailboxId, to: inbox | archive | junk | trash }
// "trash" needs the delete permission. See functions/_lib/mailConnect/routes.ts.

import { moveMessageRoute } from "../../../../_lib/mailConnect/routes";

export const onRequestPost = moveMessageRoute;
