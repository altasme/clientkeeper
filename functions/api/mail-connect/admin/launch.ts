// POST /api/mail-connect/admin/launch -- { externalUserId, returnUrl? }
// -> 201 { launchUrl, expiresAt }. Server-to-server, bearer integration
// secret. The browser is then sent to launchUrl. See
// functions/_lib/mailConnect/admin.ts.

import { integrationHandler, launchRoute } from "../../../_lib/mailConnect/admin";

export const onRequestPost = integrationHandler(launchRoute);
