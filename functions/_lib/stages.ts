// Shared stage-machine module — the allowed-transition map from the source
// spec (CLAUDEclienthubcrm.md §5), enforced server-side on every
// transition. Copied verbatim from clienthub's identical module rather
// than a shared package — see this repo's CLAUDE.md §0 for why the two
// apps' server layers are deliberately independent. If this map ever needs
// to change, update both copies together.

export const FORWARD_SEQUENCE = [
  "payment_received",
  "account_created",
  "discovery",
  "building",
  "ready_for_presentation",
  "presentation",
  "post_presentation",
  "offer_unlocked",
  "conversion",
  "essential_upsell",
] as const;

export type ForwardStage = (typeof FORWARD_SEQUENCE)[number];
export type TerminalStage = "on_hold" | "cancelled" | "completed";
export type Stage = ForwardStage | TerminalStage;

export const TERMINAL_STAGES: readonly TerminalStage[] = ["on_hold", "cancelled", "completed"];

/**
 * True if `to` is a legal next stage from `from` for a normal (non-admin
 * -override) transition: the next step in FORWARD_SEQUENCE, or any
 * terminal stage from any active (non-terminal) stage.
 */
export function isValidForwardTransition(from: Stage, to: Stage): boolean {
  if (TERMINAL_STAGES.includes(to as TerminalStage)) {
    return !TERMINAL_STAGES.includes(from as TerminalStage);
  }
  const fromIndex = FORWARD_SEQUENCE.indexOf(from as ForwardStage);
  const toIndex = FORWARD_SEQUENCE.indexOf(to as ForwardStage);
  if (fromIndex === -1 || toIndex === -1) return false;
  return toIndex === fromIndex + 1;
}

/**
 * Writes a project's stage forward one legal step and records
 * stage_history. Throws if the transition isn't in the allowed map — the
 * only way to break sequence deliberately is the separate, always-audited
 * admin-override path (functions/api/app/projects/[id]/override.ts), which
 * writes stage_history + audit_log directly rather than calling this.
 */
export async function advanceStage(
  db: D1Database,
  projectId: string,
  toStage: Stage,
  actorId: string,
  reason: string | null = null
): Promise<void> {
  const project = await db
    .prepare(`SELECT stage FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ stage: Stage }>();
  if (!project) throw new Error(`advanceStage: project ${projectId} not found`);

  if (!isValidForwardTransition(project.stage, toStage)) {
    throw new Error(`advanceStage: illegal transition ${project.stage} -> ${toStage} for project ${projectId}`);
  }

  const now = new Date().toISOString();

  await db
    .prepare(`UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?`)
    .bind(toStage, now, projectId)
    .run();

  await db
    .prepare(
      `INSERT INTO stage_history (id, project_id, from_stage, to_stage, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), projectId, project.stage, toStage, actorId, reason, now)
    .run();
}
