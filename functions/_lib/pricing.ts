// Digital Growth Plans catalog — the plan-override subset only (no
// add-ons; ClientKeeper's override control only ever sets a client's
// *plan*, not individual add-ons). Copied from clienthub's
// functions/_lib/pricing.ts rather than shared — see this repo's CLAUDE.md
// §0 for why the two apps' server layers are deliberately independent.
// Ids for the four real, purchasable plans (starter/basic/essential/
// business) MUST match clienthub's copy exactly (both the frontend
// src/content/pricing.ts there and this file's own functions/_lib/
// pricing.ts) — a client's `subscriptions.item_id` is read by both apps.
//
// "free", "299", and "partnership" (added 2026-09-16/17, CLAUDE.md §19/§21)
// are the one deliberate exception: ClientKeeper-only placeholder plans, not
// present in clienthub's catalog at all. They exist purely as labels the
// "Set Plan" override can assign for record-keeping — they do nothing (no
// renewal math beyond the shared `addInterval`-if-`renewalPhp` logic every
// plan already goes through, no clienthub checkout, no unlock behavior tied
// to them). clienthub's AccountPage.tsx already tolerates an unrecognized
// itemId gracefully (findPlan() returns undefined, it just skips the
// "included features" list and still shows the stored itemName/amount
// snapshot), so this doesn't need a matching clienthub-side catalog entry.
// "partnership" specifically has no fixed price (confirmed with the
// operator) — the real commercial terms of a partnership arrangement live
// off-system (notes/activity log), this is just a label so staff can mark
// a client as under one.
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
//
// [2026-09-07 correction] Basic changed from a ₱1,500 one-time build + a
// separate ₱750/year domain-renewal line to a single ₱1,500/year plan
// that already includes (basic-domain) renewal — see clienthub's
// functions/_lib/pricing.ts for the full note.
export const PLAN_CATALOG: PlanCatalogItem[] = [
  { id: "free", name: "Free Plan", billing: "one_time", chargeNowPhp: 0 },
  { id: "299", name: "299 Plan", billing: "one_time", chargeNowPhp: 299 },
  { id: "partnership", name: "Partnership Arrangement", billing: "one_time", chargeNowPhp: 0 },
  { id: "starter", name: "Starter Plan", billing: "one_time", chargeNowPhp: 299 },
  { id: "basic", name: "Basic Plan", billing: "annual", chargeNowPhp: 1500, renewalPhp: 1500 },
  { id: "essential", name: "Essential Plan", billing: "annual", chargeNowPhp: 5700, renewalPhp: 4200 },
  { id: "business", name: "Business Plan", billing: "annual", chargeNowPhp: 11500, renewalPhp: 10000 },
];

export function findPlan(id: string): PlanCatalogItem | undefined {
  return PLAN_CATALOG.find((p) => p.id === id);
}
