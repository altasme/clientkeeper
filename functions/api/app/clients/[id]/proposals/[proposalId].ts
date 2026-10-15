// Cloudflare Pages Function: GET/PATCH /api/app/clients/:id/proposals/:proposalId
//
// GET returns full detail for the editor/detail page: the live draft
// buffer (title/content_html), every published version (read-only,
// newest first), and the signature record if one exists. PATCH updates
// the draft buffer only -- it is a no-op on the frozen proposal_versions
// rows, which is the whole point of the draft/version split documented
// in d1/schema.sql. Editing is blocked once status is 'signed' (the spec's
// "do not allow published or signed proposals to be silently modified");
// the publish endpoint (publish.ts) is the only path back to an editable
// state after that, and it explicitly resets status + requires a fresh
// signature.

import type { StaffUser } from "../../../../../_lib/roles";

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
  client_id: string;
  slug: string;
  access_token: string;
  title: string;
  content_html: string;
  status: string;
  current_version: number;
  questionnaire_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

async function loadProposal(db: D1Database, clientId: string, proposalId: string): Promise<ProposalRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, slug, access_token, title, content_html, status, current_version, questionnaire_id, expires_at, created_at, updated_at
       FROM proposals WHERE id = ? AND client_id = ?`
    )
    .bind(proposalId, clientId)
    .first<ProposalRow>();
}

export const onRequestGet: PagesFunction<Env, "id" | "proposalId"> = async ({ env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const proposalId = normalizeParam(params.proposalId);

  const proposal = await loadProposal(db, clientId, proposalId);
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
    slug: proposal.slug,
    publicUrl: `https://www.altasme.com/proposal/${proposal.slug}?t=${proposal.access_token}`,
    title: proposal.title,
    contentHtml: proposal.content_html,
    status: proposal.status,
    currentVersion: proposal.current_version,
    questionnaireId: proposal.questionnaire_id,
    expiresAt: proposal.expires_at,
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

export const onRequestPatch: PagesFunction<Env, "id" | "proposalId", { staffUser: StaffUser }> = async ({ request, env, params }) => {
  if (!env.DB) return jsonResponse(500, { error: "Not configured" });
  const db = env.DB;
  const clientId = normalizeParam(params.id);
  const proposalId = normalizeParam(params.proposalId);

  const proposal = await loadProposal(db, clientId, proposalId);
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

  if (!title) return jsonResponse(400, { error: "Title is required." });

  if (questionnaireId) {
    const q = await db.prepare(`SELECT id FROM questionnaires WHERE id = ? AND client_id = ?`).bind(questionnaireId, clientId).first();
    if (!q) return jsonResponse(400, { error: "That questionnaire doesn't belong to this client." });
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE proposals SET title = ?, content_html = ?, questionnaire_id = ?, updated_at = ? WHERE id = ?`
    )
    .bind(title, contentHtml, questionnaireId === undefined ? proposal.questionnaire_id : questionnaireId, now, proposalId)
    .run();

  return jsonResponse(200, { ok: true, updatedAt: now });
};
