// GET /api/app/mail/threads/:id?context=<folder>[&remoteImages=1]
// Every message in a conversation (oldest first), each with its sanitized
// body. Trash/Junk messages are only included when viewing from that
// folder, so a deleted reply doesn't reappear in an Inbox conversation.

import { errorResponse, jsonResponse, normalizeParam, loadMessageDetails } from "@altasme/webmail-kit";
import { mailHandler } from "../../../../_lib/mailHandler";

export const onRequestGet = mailHandler<"id">(async ({ ctx, db, access }) => {
  const id = normalizeParam(ctx.params.id);
  const url = new URL(ctx.request.url);
  const context = url.searchParams.get("context") ?? "inbox";
  const remote = url.searchParams.get("remoteImages") === "1";
  const thread = await db
    .prepare(`SELECT id, account_id, subject, message_count FROM mail_threads WHERE id = ?`)
    .bind(id)
    .first<{ id: string; account_id: string; subject: string; message_count: number }>();
  if (!thread || !access.has(thread.account_id)) return errorResponse(404, "Conversation not found.");
  const includeFolders = context === "trash" ? null : context === "junk" ? ["inbox", "sent", "archive", "junk"] : ["inbox", "sent", "archive"];
  const messages = await loadMessageDetails(db, [thread.account_id], { threadId: id, folders: includeFolders }, remote);
  return jsonResponse(200, { id: thread.id, accountId: thread.account_id, subject: thread.subject, messages });
});
