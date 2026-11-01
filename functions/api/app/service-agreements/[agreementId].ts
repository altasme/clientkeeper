// Cloudflare Pages Function: GET/PATCH /api/app/service-agreements/:agreementId
//
// Service Agreement Generator (CLAUDE.md §29), cloned from the
// proposal generator's own flattened detail endpoint
// (functions/api/app/proposals/[proposalId].ts) -- resolved by its own
// id alone, since it can belong to a client, a lead, or neither
// (standalone), same as a proposal. No payment_* fields and no
// questionnaire_id here, unlike proposals: this is a signature-only
// document per the operator's own confirmed decision, and sending a
// signer to an intake questionnaire after accepting is a sales-funnel
// concept that belongs to the proposal that precedes a contract, not
// the contract itself.
//
// GET returns full detail for the editor/detail page: the live draft
// buffer (title/content_html), every published version (read-only,
// newest first), and the signature record if one exists. PATCH updates
// the draft buffer only -- it is a no-op on the frozen
// service_agreement_versions rows, which is the whole point of the
// draft/version split. Editing is always allowed, even once signed; the
// publish endpoint is the only path back to an editable state after
// that, and it explicitly resets status + requires a fresh signature.

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

interface ServiceAgreementRow {
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
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

async function loadAgreement(db: D1Database, agreementId: string): Promise<ServiceAgreementRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, lead_id, prospect_full_name, prospect_business_name, prospect_email, prospect_phone, slug, access_token, title, content_html, status, current_version, expires_at, created_at, updated_at
       FROM service_agreements WHERE id = ?`
    )
    .bind(agreementId)
    .first<ServiceAgreementRow>();
}

export const onRequestGet: PagesFunction<Env, "agreementId"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const agreementId = normalizeParam(params.agreementId);

  const agreement = await loadAgreement(db, agreementId);
  if (!agreement) return jsonResponse(404, { error: "Service agreement not found" });

  const versions = await db
    .prepare(`SELECT id, version_number, title, content_html, created_at FROM service_agreement_versions WHERE service_agreement_id = ? ORDER BY version_number DESC`)
    .bind(agreementId)
    .all<{ id: string; version_number: number; title: string; content_html: string; created_at: string }>();

  const signature = await db
    .prepare(`SELECT id, version_id, signer_name, signer_title, signature_data_url, ip_address, signed_at FROM service_agreement_signatures WHERE service_agreement_id = ? ORDER BY signed_at DESC LIMIT 1`)
    .bind(agreementId)
    .first<{ id: string; version_id: string; signer_name: string; signer_title: string | null; signature_data_url: string; ip_address: string | null; signed_at: string }>();

  return jsonResponse(200, {
    id: agreement.id,
    clientId: agreement.client_id,
    leadId: agreement.lead_id,
    prospectFullName: agreement.prospect_full_name,
    prospectBusinessName: agreement.prospect_business_name,
    prospectEmail: agreement.prospect_email,
    prospectPhone: agreement.prospect_phone,
    slug: agreement.slug,
    publicUrl: `https://www.altasme.com/agreement/${agreement.slug}?t=${agreement.access_token}`,
    title: agreement.title,
    contentHtml: agreement.content_html,
    status: agreement.status,
    currentVersion: agreement.current_version,
    expiresAt: agreement.expires_at,
    createdAt: agreement.created_at,
    updatedAt: agreement.updated_at,
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

export const onRequestPatch: PagesFunction<Env, "agreementId", { staffUser: StaffUser }> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const agreementId = normalizeParam(params.agreementId);

  const agreement = await loadAgreement(db, agreementId);
  if (!agreement) return jsonResponse(404, { error: "Service agreement not found" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
  const b = body as Record<string, unknown>;

  const title = typeof b.title === "string" ? b.title.trim() : agreement.title;
  const contentHtml = typeof b.contentHtml === "string" ? b.contentHtml : agreement.content_html;

  if (!title) return jsonResponse(400, { error: "Title is required." });

  const now = new Date().toISOString();
  await db.prepare(`UPDATE service_agreements SET title = ?, content_html = ?, updated_at = ? WHERE id = ?`).bind(title, contentHtml, now, agreementId).run();

  return jsonResponse(200, { ok: true, updatedAt: now });
};
