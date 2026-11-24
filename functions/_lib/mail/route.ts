// Shared wrapper for every /api/app/mail/* handler: resolves the caller's
// mailbox access once, and turns any unexpected exception into a generic
// 500 (details go to the Workers log only -- never to the browser, so no
// SQL, stack trace or SMTP detail ever leaks in a response).

import type { StaffUser } from "../roles";
import { loadAccess, type MailAccess } from "./access";
import type { MailEnv } from "./config";
import { errorResponse } from "./http";

export type MailContext<P extends string = string> = EventContext<MailEnv & { SESSION_SECRET?: string }, P, { staffUser: StaffUser }>;

export interface MailHandlerArgs<P extends string> {
  ctx: MailContext<P>;
  db: D1Database;
  user: StaffUser;
  access: MailAccess;
}

export function mailHandler<P extends string = string>(fn: (args: MailHandlerArgs<P>) => Promise<Response>): PagesFunction<MailEnv, P, { staffUser: StaffUser }> {
  return async (ctx) => {
    const db = ctx.env.DB;
    if (!db) return errorResponse(500, "Not configured");
    try {
      const user = ctx.data.staffUser;
      const access = await loadAccess(db, user.id);
      return await fn({ ctx: ctx as MailContext<P>, db, user, access });
    } catch (err) {
      console.error("mail route error", ctx.request.method, new URL(ctx.request.url).pathname, err instanceof Error ? err.stack || err.message : err);
      return errorResponse(500, "Something went wrong processing this mail request.");
    }
  };
}
