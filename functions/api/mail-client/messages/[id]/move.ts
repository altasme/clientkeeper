// POST /api/mail-client/messages/:id/move -- { to: inbox | archive | junk | trash }
// See functions/_lib/mailClient/routes.ts.

import { moveMessageRoute } from "../../../../_lib/mailClient/routes";

export const onRequestPost = moveMessageRoute;
