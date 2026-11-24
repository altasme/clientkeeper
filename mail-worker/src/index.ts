// ClientKeeper mail worker -- a standalone Cloudflare Worker (not a Pages
// Function: Email Routing can only deliver to a Worker's email() handler).
//
//   email()     -> inbound mail from Cloudflare Email Routing -> D1/R2 (inbound.ts)
//   scheduled() -> every minute: retry due outbound sends, reap sends stuck
//                  mid-flight, purge Trash older than 30 days
//                  (functions/_lib/mail/send.ts processDueSendJobs)
//
// Shares its D1 database (binding DB) and private R2 bucket (binding
// MAIL_ATTACHMENTS) with the ClientKeeper Pages project, and the same
// functions/_lib/mail/* modules, so both write identical rows.

import { processDueSendJobs } from "../../functions/_lib/mail/send";
import { cloudflareSmtpTransport } from "../../functions/_lib/mail/smtpTransport";
import { processInbound, type WorkerEnv } from "./inbound";

export default {
  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    try {
      const outcome = await processInbound(env, { raw, envelopeFrom: message.from, envelopeTo: message.to });
      if (outcome.status === "rejected") message.setReject(outcome.reason);
    } catch (err) {
      console.error("inbound processing failed", err instanceof Error ? err.message : err);
      if (env.MAIL_FALLBACK_FORWARD) {
        // The raw copy is already in R2 and the failure is recorded; also
        // hand the message to a human-monitored mailbox so it's not stuck.
        await message.forward(env.MAIL_FALLBACK_FORWARD);
        return;
      }
      // No fallback configured: fail the delivery so the sending server
      // knows the message didn't arrive (rather than accepting and losing it).
      throw err;
    }
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      processDueSendJobs(env, cloudflareSmtpTransport).then(
        (r) => {
          if (r.reaped || r.attempted || r.purged) console.log("mail cron", JSON.stringify(r));
        },
        (err) => console.error("mail cron failed", err instanceof Error ? err.message : err)
      )
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
