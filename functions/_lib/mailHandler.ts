// Thin, app-specific adapter: pins @altasme/webmail-kit's generic
// mailHandler()/MailHandlerArgs to this app's own StaffUser type, so every
// route importing from here (instead of the package directly) gets full
// typing on `args.user` without repeating the generic parameter at every
// call site. This is the ONE file in this app that's allowed to bridge
// the package's generic MailUser to our concrete StaffUser -- every route
// should import mailHandler/MailHandlerArgs from here, not from the
// package.
import { mailHandler as genericMailHandler, type MailHandlerArgs as GenericMailHandlerArgs } from "@altasme/webmail-kit";
import type { StaffUser } from "./roles";

export type MailHandlerArgs<P extends string = string> = GenericMailHandlerArgs<P, StaffUser>;

export function mailHandler<P extends string = string>(fn: (args: MailHandlerArgs<P>) => Promise<Response>) {
  return genericMailHandler<P, StaffUser>(fn);
}
