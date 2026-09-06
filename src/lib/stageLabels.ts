// Display labels matching clienthub/d1/schema.sql's project_stages seed
// data — kept here rather than fetched from that table on every page load,
// since the set is static and shared by both apps by convention (if the
// stage set ever changes, update both the schema seed and this map
// together).
import type { Stage } from "./api";

export const STAGE_LABELS: Record<Stage, string> = {
  payment_received: "Payment Received",
  account_created: "Account Created",
  discovery: "Discovery",
  building: "Building",
  ready_for_presentation: "Ready for Presentation",
  presentation: "Presentation",
  post_presentation: "Post-Presentation",
  offer_unlocked: "Offer Unlocked",
  conversion: "Conversion (1499)",
  essential_upsell: "Essential Upsell",
  on_hold: "On Hold",
  cancelled: "Cancelled",
  completed: "Completed",
};

// The one legal next forward stage from a given stage, for rendering a
// single contextual "advance" button — mirrors functions/_lib/stages.ts's
// FORWARD_SEQUENCE without duplicating the whole module in the frontend
// bundle. Stages not in this map have no plain forward advance (either
// terminal, or gated behind the offer-unlock action instead).
export const NEXT_FORWARD_STAGE: Partial<Record<Stage, Stage>> = {
  payment_received: "account_created",
  account_created: "discovery",
  discovery: "building",
  building: "ready_for_presentation",
  ready_for_presentation: "presentation",
  presentation: "post_presentation",
  // post_presentation -> offer_unlocked and conversion -> essential_upsell
  // are intentionally absent: those two moves only happen via the offer
  // unlock action (src/pages/ClientDetailPage.tsx), never a plain advance.
};

export const ALL_STAGES: Stage[] = Object.keys(STAGE_LABELS) as Stage[];
