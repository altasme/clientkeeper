// GET  /api/mail-connect/signatures?mailboxId=  -- list (read)
// POST /api/mail-connect/signatures             -- create (settings permission)
// See functions/_lib/mailConnect/routes.ts.

import { createSignatureRoute, listSignaturesRoute } from "../../_lib/mailConnect/routes";

export const onRequestGet = listSignaturesRoute;
export const onRequestPost = createSignatureRoute;
