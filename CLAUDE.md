# CLAUDE.md: ClientKeeper (Internal CRM)

**Artifact type:** Build specification for Claude Code
**Functional source:** `CLAUDEclienthubcrm.md` (v2.1) is authoritative for scope, stage machine, security rules, and copy — same source as the sibling `clienthub` repo. This file documents the concrete implementation decisions made while building this half of the system.
**Domain:** `clientkeeper.altasme.com`
**Sibling app:** `clienthub` (`account.altasme.com`) — the client-facing portal. Separate repo, separate Cloudflare Pages deployment, **same D1 database**. **`clienthub/CLAUDE.md` and `clienthub/d1/schema.sql` are the canonical references for the shared data model, stage machine, and account-creation bridge — read those first.** This file covers only what's specific to this app.

---

## 0. What this app is, and isn't

- **ClientKeeper is the source of truth.** A client's stage and offer visibility are derived from data only staff can write here. `clienthub` reads this data but has no path to mutate stage/offer/plan.
- **Zero public endpoints.** Every route in this app requires an authenticated, role-checked WorkOS session. There is no anonymous entry point — payment webhooks, invitation callbacks, and all client-facing traffic live in `clienthub`, not here. This is deliberate isolation: a bug in `clienthub`'s client-facing code has no code path into anything here.
- Not a monorepo with `clienthub` — separate repo, separate deployment, connected only through the shared D1 database (see `clienthub/CLAUDE.md` §3 for the binding setup — both projects must bind the *same* database id under variable name `DB`).

---

## 1. Auth + roles

- WorkOS AuthKit, same as `clienthub`, called via plain `fetch()` (no Node SDK — Workers isn't a Node runtime).
- **Staff roles (Owner/Developer/Admin/Sales) live in the shared D1 `users` table**, not in WorkOS — see `clienthub/CLAUDE.md` §1.3 for the full reasoning (WorkOS roles require an Organization Membership, which is unnecessary complexity for a V1 with no self-service staff-invite UI). Every request here does a two-step check: (1) validate the WorkOS session is real and unexpired, (2) look up `users` by `workos_user_id` and confirm a role exists and is allowed for the endpoint. No `users` row = no access, regardless of a valid WorkOS session — a valid login is necessary but not sufficient.
- Adding a new staff member in V1 is a manual process: invite them via `clienthub`'s invitation flow (or directly via the WorkOS dashboard), confirm their `workos_user_id` once they sign up, then insert a row into `users` with their role. There is no in-app "add staff" UI in V1 — build one only if this manual step becomes a real friction point.

---

## 2. V1 scope (source spec §20–§36, §39)

- **Dashboard:** today's counts (new clients, discovery, building, presentations, offers unlocked, conversions) + active clients table.
- **Nav:** Dashboard, Leads, Clients, Projects, Discovery, Presentations, Offers, Resources (deferred, see below), Payments, Settings. No Messages nav — chat is an external channel handoff from `clienthub`, communication here is a manual log only.
- **Leads:** pre-payment records + statuses, `source` carried through.
- **Client record:** identity, funnel, project, commercial, communication (manual notes + logged call-requests from the interim booking behavior — see `clienthub/CLAUDE.md` §1.6).
- **Discovery/Presentation management:** internal fields + statuses; the client only ever sees `external_status` (never `internal_notes`) via `clienthub`'s own endpoints.
- **Project controls:** Start Discovery, Mark Discovery Complete, Start Build, Mark Ready for Presentation, Mark Presentation Complete, Unlock ₱1,499 Offer, Unlock Next Offer. Sensitive actions require confirmation in the UI.
- **Admin override:** manual stage change requires a reason; writes `audit_log` + `stage_history` (shared tables, see `clienthub/CLAUDE.md` §4 for the stage machine and transition-map rules — the map is duplicated here in this app's own stage-machine module rather than shared as a package; see that section for why).
- **Stage history + activity timeline** per client.
- **"Paid, no account yet" list + Resend invite action** — reads `clients` where `invitation_status != 'accepted'`; the resend action calls the same WorkOS invitation endpoint `clienthub` uses on first issuance.
- **Resource library: deferred to V1.1**, matching `clienthub`'s deferral (confirmed with the user, source spec's own most-deferrable flag). No resources UI/tables in V1.

---

## 3. Commercial unlock + offer engine

- Offers are locked until unlocked here. First unlockable = ₱1,499; Essential unlocks only after ₱1,499 is completed. The full pricing table is never exposed anywhere, including in this app's own UI beyond what's relevant to the current stage.
- `offers.content` is a JSON blob (DB-configurable), not hardcoded copy — see `clienthub/d1/schema.sql`'s `offers` table. The ₱1,499 offer ships with placeholder content until the real price/copy is provided (source spec open item #5); do not invent real-sounding numbers to fill the placeholder.
- Unlock is admin-only; every unlock/view/accept/decline writes an `offer_events` row.

---

## 4. Security

Same acceptance-test bar as `clienthub` (source spec §6), adapted for a staff app:

- Every endpoint authenticates the WorkOS session **and** checks the caller's D1 role before doing anything.
- Sensitive mutations (stage override, offer unlock) write `audit_log` with actor, before/after, and reason.
- No endpoint here is reachable without a valid session — confirm this explicitly as part of QA for every new endpoint (unauthenticated request → 401, wrong-role request → 403).

---

## 5. Definition of done (V1)

- [x] Behind WorkOS AuthKit with D1-backed role checks on every endpoint. `functions/api/app/_middleware.ts` gates the entire `/api/app/*` tree; `functions/api/auth-{start,callback,logout}.ts` are the only unauthenticated routes, as they must be to bootstrap login at all.
- [x] Dashboard, Leads, Clients, Projects, Discovery, Presentations, Offers, Payments, Settings nav sections built (`src/pages/*.tsx`, wired in `src/App.tsx`/`src/components/Layout.tsx`).
- [x] Stage controls enforce the transition map; admin override requires a reason and writes `audit_log`.
- [x] Commercial unlock endpoints stage-gate correctly; offer content is DB-configurable (ships with a clearly-marked placeholder for both offer types until real ₱1,499/Essential copy is supplied — open item #5).
- [x] "Paid, no account yet" list + resend-invite action work end to end (surfaced as a filter on the Clients page rather than a separate nav item, since it's the same underlying client record set — `paidNoAccount=1` on `GET /api/app/clients`, the action itself at `POST /api/app/clients/:id/resend-invite`).
- [x] Every acceptance test in source spec §6 passes for this app's endpoints specifically — **verified live**, not just by code review, against a local `wrangler pages dev` + local D1 instance (schema applied from `clienthub/d1/schema.sql`, a `.dev.vars`/`wrangler.toml` pair created and deleted after the test session per this project's established secrets discipline, never committed):
  - No cookie → `401` on `/api/app/me`.
  - A validly-signed session cookie for a WorkOS user with no matching `users` row → `403` ("No staff role configured for this account") — confirms a real WorkOS login alone grants nothing.
  - A tampered/invalid cookie signature → `401`.
  - A validly-signed session for a real `users` row → `200` with the correct staff identity.
  - Real data endpoints (`/api/app/dashboard`, `/api/app/clients`) return correct results against the local D1.
  - The stage machine: a legal forward advance (`discovery` → `building`) succeeds; an illegal skip (`building` → `conversion` directly) is rejected `409`; moving into `offer_unlocked`/`essential_upsell` via the plain advance endpoint is rejected `400` (must go through the offer-unlock endpoint instead).
  - Admin override: a stage skip with a reason succeeds and is audited; the same call with no reason is rejected `400`.
  - The offer engine: unlocking ₱1,499 from `post_presentation` succeeds and advances the project to `offer_unlocked`; unlocking it again is rejected `409` (already exists); unlocking Essential before ₱1,499 is accepted is rejected `409`.
  - `audit_log`, `stage_history`, and `offer_events` rows were all queried directly afterward and confirmed to hold the correct actor, before/after state, and reason for every sensitive mutation above.
  - No client-writable path exists in this app by definition, since there are no client-facing endpoints at all (client-facing traffic lives entirely in `clienthub`).

---

## 6. Guardrails

1. No public/anonymous endpoint of any kind — every route requires a valid staff session with a matching D1 role.
2. Never expose the full pricing table, only the currently-relevant offer.
3. Every sensitive action (override, unlock, invite reissue) is audited — no silent mutations.
4. Do not build the resource library before it's scheduled for V1.1.
5. Do not build real booking-system integration before its spec is supplied (see `clienthub/CLAUDE.md` §1.6) — this app's UI for discovery/presentation scheduling works against the interim call-request data only.

---

## 7. Implementation notes (V1 build)

- **Session cookie** (`functions/_lib/session.ts`): `ck_session`, distinct from clienthub's `ch_session` so the two are never confused even though they'd never actually collide (different domains). Payload is `{workosUserId, issuedAt}` only — no role, no cached data — because every request re-queries the `users` table (`functions/_lib/roles.ts`) for the caller's *current* role. A revoked or changed role therefore takes effect on that person's very next request, not at cookie expiry. Max age is 12 hours (vs. clienthub's 30 days), a deliberate tighter window since this is an internal tool gating stage/offer mutations, not a client-facing portal.
- **Auth flow mirrors clienthub's exactly** (`functions/api/auth-{start,callback,logout}.ts`, `functions/_lib/workos.ts`), including `prompt=login` on the authorize URL for the same reason clienthub added it (never silently reuse an existing AuthKit browser session). The one structural difference: clienthub's callback links a *client* record; this app's callback looks up a *staff* row in `users` and rejects outright (`?error=not_staff`) if none exists — there is no self-service staff signup, by design (§1).
- **The generic stage-advance endpoint deliberately blocks two stages.** `functions/api/app/projects/[id]/advance.ts` enforces the plain forward-sequence map (`functions/_lib/stages.ts`, copied verbatim from clienthub, not shared as a package — see §0) but explicitly rejects `toStage: "offer_unlocked"` or `"essential_upsell"`. Those two moves only happen through `functions/api/app/offers/unlock.ts`, which creates the actual `offers` row and writes `offer_events` *before* advancing the stage — a bare stage flip with no offer row behind it would leave `clienthub`'s client dashboard assuming an offer exists when it doesn't. This was verified live (see §5): attempting `offer_unlocked` via the plain advance endpoint returns `400`, directing the caller to the unlock endpoint instead.
- **The frontend never re-derives the transition map.** `src/lib/stageLabels.ts`'s `NEXT_FORWARD_STAGE` is a small, presentation-only mirror (which single button to show for a given current stage) — the real enforcement is server-side in `advance.ts`/`override.ts`. The two offer-gated stages are deliberately absent from this map so no plain "advance" button ever renders for them; the contextual "Unlock ₱1,499 Offer"/"Unlock Next Offer" buttons in `ClientDetailPage.tsx` are gated on `project.stage` directly instead.
- **Recording an offer decision is a staff action, not a client one, in V1.** `functions/api/app/offers/[id]/decision.ts` lets staff record "accepted"/"declined" based on a decision communicated off-platform (chat, a call) — clienthub doesn't yet have a self-serve accept/decline UI of its own. Accepting the ₱1,499 offer is the one decision that moves the project forward on its own (`offer_unlocked` → `conversion`, a legal step in the forward sequence); declining does not auto-change the stage, since what happens next after a declined sale is a staff judgment call, not something this endpoint should guess at.
- **"Paid, no account yet" is a filter, not a separate nav item.** `GET /api/app/clients?paidNoAccount=1` and the resend-invite button live on the same Clients page/detail view as everything else, since it's the same underlying `clients` record set (`invitation_status != 'accepted'`) — adding a whole separate screen for one filter condition would just fork the same data two ways.
- **Manual client notes vs. logged call-requests.** `client_activity` (via `POST /api/app/clients/:id/activity`) is for free-text staff notes only. The structured `preferred_times` a client submits through clienthub's interim booking flow lives on `discovery_sessions`/`presentations` directly, not in `client_activity` — the two are different kinds of record and were kept that way rather than unifying them into one feed.
- **The dashboard's "today's counts" reads as today's *activity*, not current totals-by-stage.** CLAUDE.md's source spec (§20) lists "new clients, discovery, building, presentations, offers unlocked, conversions" without specifying which interpretation; `functions/api/app/dashboard.ts` counts *transitions into* each stage today (via `stage_history`/`offer_events` timestamps), since a running total-in-stage doesn't answer "what happened today" the way a daily ops dashboard needs to — the Projects/Clients pages already cover current totals.
- **Verified against a real local D1, not just code review** (see §5's Definition of Done for the exact scenarios exercised): schema applied from `clienthub/d1/schema.sql`, a staff `users` row and a test `clients`/`projects` row seeded by hand, then driven through `wrangler pages dev` with a gitignored `.dev.vars`/`wrangler.toml` pair (both deleted immediately after the test session, never committed, matching this project's established secrets discipline). This caught nothing wrong, but it's the difference between "the code looks right" and "the code was actually run."
