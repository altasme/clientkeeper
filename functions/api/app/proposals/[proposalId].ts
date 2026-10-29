// Cloudflare Pages Function: GET/PATCH /api/app/proposals/:proposalId
//
// [2026-10-15] Replaces the old client-nested
// /api/app/clients/:id/proposals/:proposalId -- a proposal is now
// resolved by its own id alone, since it can belong to either a client
// or a lead (CLAUDE.md §25: "a proposal generator that doesn't need a
// client"). Nesting under a parent made sense when there was only ever
// one kind of parent; keeping both /clients/:id/proposals/index.ts and
// /leads/:id/proposals/index.ts for listing/creation (parent-scoped,
// since "all of this client's/lead's proposals" is a meaningful list)
// but flattening everything that only ever needs the proposal's own id
// avoids duplicating this detail/publish/revoke logic per parent type.
//
// GET returns full detail for the editor/detail page: the live draft
// buffer (title/content_html), every published version (read-only,
// newest first), the signature record if one exists, and which parent
// (clientId or leadId) owns it so the frontend can build the right
// "back to..." link and show/hide the questionnaire-link card (a
// questionnaire can only ever be linked to a client-backed proposal,
// see schema.sql's note on questionnaires.client_id staying required).
// PATCH updates the draft buffer only -- it is a no-op on the frozen
// proposal_versions rows, which is the whole point of the draft/version
// split documented in d1/schema.sql. Editing is blocked once status is
// 'signed' only in the sense that it doesn't touch the signature; the
// publish endpoint (publish.ts) is the only path back to an editable
// state after that, and it explicitly resets status + requires a fresh
// signature.
//
// [2026-10-29] PATCH also updates the five payment_* fields (CLAUDE.md
// §27) -- unlike title/contentHtml, these aren't versioned content and
// take effect immediately, even on an already-signed proposal (fixing a
// typo'd GCash number shouldn't require re-publishing and forcing the
// client to sign again).

import type { StaffUser } from "../../../_lib/roles";

interface Env {
  DB?: D1Database;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function normalizeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

interface ProposalRow {
  id: string;
  client_id: string | null;
  lead_id: string | null;
  prospect_full_name: string | null;
  prospect_business_name: string | null;
  prospect_email: string | null;
  prospect_phone: string | null;
  slug: string;
  access_token: string;
  title: string;
  content_html: string;
  status: string;
  current_version: number;
  questionnaire_id: string | null;
  expires_at: string | null;
  payment_enabled: number;
  payment_amount_label: string;
  payment_gcash_number: string;
  payment_gcash_account_name: string;
  payment_bank_note: string;
  payment_marked_paid_at: string | null;
  created_at: string;
  updated_at: string;
}

async function loadProposal(db: D1Database, proposalId: string): Promise<ProposalRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, lead_id, prospect_full_name, prospect_business_name, prospect_email, prospect_phone, slug, access_token, title, content_html, status, current_version, questionnaire_id, expires_at, payment_enabled, payment_amount_label, payment_gcash_number, payment_gcash_account_name, payment_bank_note, payment_marked_paid_at, created_at, updated_at
       FROM proposals WHERE id = ?`
    )
    .bind(proposalId)
    .first<ProposalRow>();
}

export const onRequestGet: PagesFunction<Env, "proposalId"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const proposalId = normalizeParam(params.proposalId);

  const proposal = await loadProposal(db, proposalId);
  if (!proposal) return jsonResponse(404, { error: "Proposal not found" });

  const versions = await db
    .prepare(`SELECT id, version_number, title, content_html, created_at FROM proposal_versions WHERE proposal_id = ? ORDER BY version_number DESC`)
    .bind(proposalId)
    .all<{ id: string; version_number: number; title: string; content_html: string; created_at: string }>();

  const signature = await db
    .prepare(`SELECT id, version_id, signer_name, signer_title, signature_data_url, ip_address, signed_at FROM proposal_signatures WHERE proposal_id = ? ORDER BY signed_at DESC LIMIT 1`)
    .bind(proposalId)
    .first<{ id: string; version_id: string; signer_name: string; signer_title: string | null; signature_data_url: string; ip_address: string | null; signed_at: string }>();

  return jsonResponse(200, {
    id: proposal.id,
    clientId: proposal.client_id,
    leadId: proposal.lead_id,
    prospectFullName: proposal.prospect_full_name,
    prospectBusinessName: proposal.prospect_business_name,
    prospectEmail: proposal.prospect_email,
    prospectPhone: proposal.prospect_phone,
    slug: proposal.slug,
    publicUrl: `https://www.altasme.com/proposal/${proposal.slug}?t=${proposal.access_token}`,
    title: proposal.title,
    contentHtml: proposal.content_html,
    status: proposal.status,
    currentVersion: proposal.current_version,
    questionnaireId: proposal.questionnaire_id,
    expiresAt: proposal.expires_at,
    paymentEnabled: !!proposal.payment_enabled,
    paymentAmountLabel: proposal.payment_amount_label,
    paymentGcashNumber: proposal.payment_gcash_number,
    paymentGcashAccountName: proposal.payment_gcash_account_name,
    paymentBankNote: proposal.payment_bank_note,
    paymentMarkedPaidAt: proposal.payment_marked_paid_at,
    createdAt: proposal.created_at,
    updatedAt: proposal.updated_at,
    versions: versions.results.map((v) => ({ id: v.id, versionNumber: v.version_number, title: v.title, contentHtml: v.content_html, createdAt: v.created_at })),
    signature: signature
      ? {
          id: signature.id,
          versionId: signature.version_id,
          signerName: signature.signer_name,
          signerTitle: signature.signer_title,
          signatureDataUrl: signature.signature_data_url,
          ipAddress: signature.ip_address,
          signedAt: signature.signed_at,
        }
      : null,
  });
};

export const onRequestPatch: PagesFunction<Env, "proposalId", { staffUser: StaffUser }> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const proposalId = normalizeParam(params.proposalId);

  const proposal = await loadProposal(db, proposalId);
  if (!proposal) return jsonResponse(404, { error: "Proposal not found" });
  // Editing the draft buffer is always allowed, even once signed -- this
  // is how a "material revision" starts (spec: "do not allow published
  // or signed proposals to be SILENTLY modified... require a new
  // acceptance"). The signed version/signature itself is never touched
  // by this PATCH; publish.ts is what actually snapshots a new version
  // and resets status (+ requires a fresh signature) once the admin
  // explicitly publishes the edited draft.

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const title = typeof b.title === "string" ? b.title.trim() : proposal.title;
  const contentHtml = typeof b.contentHtml === "string" ? b.contentHtml : proposal.content_html;
  const questionnaireId = b.questionnaireId === null ? null : typeof b.questionnaireId === "string" && b.questionnaireId.trim() ? b.questionnaireId.trim() : undefined;

  // Payment-request fields (CLAUDE.md §27) -- operational, not versioned
  // content, so they're PATCHed directly here same as title/contentHtml
  // rather than only taking effect on the next publish.
  const paymentEnabled = typeof b.paymentEnabled === "boolean" ? (b.paymentEnabled ? 1 : 0) : proposal.payment_enabled;
  const paymentAmountLabel = typeof b.paymentAmountLabel === "string" ? b.paymentAmountLabel.trim() : proposal.payment_amount_label;
  const paymentGcashNumber = typeof b.paymentGcashNumber === "string" ? b.paymentGcashNumber.trim() : proposal.payment_gcash_number;
  const paymentGcashAccountName = typeof b.paymentGcashAccountName === "string" ? b.paymentGcashAccountName.trim() : proposal.payment_gcash_account_name;
  const paymentBankNote = typeof b.paymentBankNote === "string" ? b.paymentBankNote.trim() : proposal.payment_bank_note;

  if (!title) return jsonResponse(400, { error: "Title is required." });

  if (questionnaireId) {
    if (!proposal.client_id) {
      // A lead-backed proposal has no client yet, and every
      // questionnaire belongs to a client (schema.sql's
      // questionnaires.client_id stays NOT NULL) -- there is nothing a
      // lead-backed proposal could ever validly link to.
      return jsonResponse(400, { error: "This proposal has no client yet, so it can't be linked to a questionnaire." });
    }
    const q = await db.prepare(`SELECT id FROM questionnaires WHERE id = ? AND client_id = ?`).bind(questionnaireId, proposal.client_id).first();
    if (!q) return jsonResponse(400, { error: "That questionnaire doesn't belong to this client." });
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE proposals SET title = ?, content_html = ?, questionnaire_id = ?, payment_enabled = ?, payment_amount_label = ?, payment_gcash_number = ?, payment_gcash_account_name = ?, payment_bank_note = ?, updated_at = ? WHERE id = ?`
    )
    .bind(
      title,
      contentHtml,
      questionnaireId === undefined ? proposal.questionnaire_id : questionnaireId,
      paymentEnabled,
      paymentAmountLabel,
      paymentGcashNumber,
      paymentGcashAccountName,
      paymentBankNote,
      now,
      proposalId
    )
    .run();

  return jsonResponse(200, { ok: true, updatedAt: now });
};
