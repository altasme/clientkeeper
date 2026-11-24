// ClientKeeper mail worker -- a standalone Cloudflare Worker (not a Pages
// Function: Email Routing can only deliver to a Worker's email() handler,
// and Pages Functions have no cron). Shares its D1 database (binding DB)
// and private R2 bucket (binding MAIL_ATTACHMENTS) with the ClientKeeper
// Pages project.
//
// The actual email()/scheduled() logic lives in @altasme/webmail-kit's
// ready-made worker entry -- see that package's docs/architecture.md for
// what it does. This file is intentionally just a re-export: if custom
// behavior is ever needed on top, import processInbound/
// processDueSendJobs/cloudflareSmtpTransport from the package directly
// and write a real custom entry here instead of editing the package.
export { default } from "@altasme/webmail-kit/worker";
