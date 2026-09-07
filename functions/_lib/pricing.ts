// Digital Growth Plans catalog — the plan-override subset only (no
// add-ons; ClientKeeper's override control only ever sets a client's
// *plan*, not individual add-ons). Copied from clienthub's
// functions/_lib/pricing.ts rather than shared — see this repo's CLAUDE.md
// §0 for why the two apps' server layers are deliberately independent.
// Ids MUST match clienthub's copy exactly (both the frontend
// src/content/pricing.ts there and this file's own functions/_lib/
// pricing.ts) — a client's `subscriptions.item_id` is read by both apps.

export type BillingCycle = "one_time" | "annual" | "monthly";

export interface PlanCatalogItem {
  id: string;
  name: string;
  billing: BillingCycle;
  chargeNowPhp: number;
  renewalPhp?: number;
}

// "custom" is deliberately excluded — it's quote-only with no fixed price,
// so it isn't something a plain "set this plan" override can express.
export const PLAN_CATALOG: PlanCatalogItem[] = [
  { id: "starter", name: "Starter Plan", billing: "one_time", chargeNowPhp: 299 },
  { id: "basic", name: "Basic Plan", billing: "one_time", chargeNowPhp: 1500, renewalPhp: 750 },
  { id: "essential", name: "Essential Plan", billing: "annual", chargeNowPhp: 5700, renewalPhp: 4200 },
  { id: "business", name: "Business Plan", billing: "annual", chargeNowPhp: 11500, renewalPhp: 10000 },
];

export function findPlan(id: string): PlanCatalogItem | undefined {
  return PLAN_CATALOG.find((p) => p.id === id);
}
