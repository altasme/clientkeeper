// ClientKeeper mail worker -- a standalone Cloudflare Worker (not a Pages
// Function: Email Routing can only deliver to a Worker's email() handler,
// and Pages Functions have no cron). Shares its D1 database (binding DB)
// and private R2 bucket (binding MAIL_ATTACHMENTS) with the ClientKeeper
// Pages project.
//
// email()     -> @altasme/webmail-kit's own handler, unchanged (inbound
//                mail from Cloudflare Email Routing -> D1/R2).
// scheduled() -> @altasme/webmail-kit's own handler, unchanged (outbound
//                retries, stuck-send reaping, Trash purge), PLUS the Z.com
//                inbound poll sync for bridged client mailboxes
//                (zcomPollSync.ts, CLAUDE.md §35).
//
// This is the package's documented extension pattern: custom behavior goes
// in a custom entry here, composed on top of the package, never as an edit
// to the package. Delegating to the package's own default handler (rather
// than re-assembling its email()/scheduled() from the named pieces) keeps
// that behavior exactly what it was when this file was a plain re-export.
//
// The provider comes from the same registry the Pages Functions use
// (functions/_lib/emailServices/provider), imported directly, the same way
// this worker imported functions/_lib/mail/* before the package existed.
// Today that is always the NotConfiguredProvider placeholder, so the poll
// sync skips itself silently; no provider secrets exist for this worker.

import kitWorker from "@altasme/webmail-kit/worker";
import type { WorkerEnv } from "@altasme/webmail-kit/worker/inbound";
import { getEmailProvider } from "../../functions/_lib/emailServices/provider";
import { runZcomPollSync } from "./zcomPollSync";

export default {
  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    await kitWorker.email(message, env);
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    await kitWorker.scheduled(controller, env, ctx);
    ctx.waitUntil(
      runZcomPollSync(env, getEmailProvider("zcom")).then(
        (r) => {
          if (r.mailboxes.length) console.log("zcom poll sync", JSON.stringify(r.mailboxes));
        },
        (err) => console.error("zcom poll sync failed", err instanceof Error ? err.message : err)
      )
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
