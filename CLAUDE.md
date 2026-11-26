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
- Adding a new staff member in V1 is a manual process: invite them directly via the WorkOS dashboard, confirm their `workos_user_id` once they sign up, then insert a row into `users` with their role. There is no in-app "add staff" UI in V1 — build one only if this manual step becomes a real friction point. (Neither app calls WorkOS's invitations API anymore as of the "one way in" fix below — `sendInvitation()` was deleted from both repos' `_lib/workos.ts` — so a WorkOS dashboard invite really is the only invitation path left, for staff or otherwise.)

---

## 2. V1 scope (source spec §20–§36, §39)

- **Dashboard:** today's counts (new clients, discovery, building, presentations, offers unlocked, conversions) + active clients table.
- **Nav:** Dashboard, Leads, Clients, Projects, Discovery, Presentations, Offers, Resources (deferred, see below), Payments, Settings. No Messages nav — chat is an external channel handoff from `clienthub`, communication here is a manual log only.
- **Leads:** pre-payment records + statuses, `source` carried through.
- **Client record:** identity, funnel, project, commercial, communication (manual notes, plus the real booking engine's scheduled times/meeting links — see `clienthub/CLAUDE.md` §10, and §7 below for this app's own side of it).
- **Discovery/Presentation management:** internal fields + statuses; the client only ever sees `external_status`/`meeting_link` (never `internal_notes`) via `clienthub`'s own endpoints. Presentation scheduling is staff-driven end to end — no client-facing presentation scheduling exists anywhere in the system, per the operator's explicit split (`clienthub/CLAUDE.md` §10).
- **Project controls:** Start Discovery, Mark Discovery Complete, Start Build, Mark Ready for Presentation, Mark Presentation Complete, Unlock ₱1,499 Offer, Unlock Next Offer. Sensitive actions require confirmation in the UI.
- **Admin override:** manual stage change requires a reason; writes `audit_log` + `stage_history` (shared tables, see `clienthub/CLAUDE.md` §4 for the stage machine and transition-map rules — the map is duplicated here in this app's own stage-machine module rather than shared as a package; see that section for why).
- **Stage history + activity timeline** per client.
- **"Paid, no account yet" list + Resend Account Setup Email action** — reads `clients` where `invitation_status != 'accepted'`; the resend action re-sends a plain Resend reminder email (not a WorkOS invitation — see the "one way in" fix in §5's Definition of Done) pointing at the same `/api/auth-start?intent=signup` link the client's original payment-confirmation email carried.
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
- [x] "Paid, no account yet" list + resend-account-reminder action work end to end (surfaced as a filter on the Clients page rather than a separate nav item, since it's the same underlying client record set — `paidNoAccount=1` on `GET /api/app/clients`, the action itself at `POST /api/app/clients/:id/resend-invite`, which now sends a Resend email rather than a WorkOS invitation — see §7's "one way in" fix).
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
5. ~~Do not build real booking-system integration before its spec is supplied~~ **RESOLVED [2026-09-07]** — the real spec arrived; this app manages availability rules and presentation scheduling, both conflict-checked against the same grid `clienthub`'s client-facing booking uses. See `clienthub/CLAUDE.md` §10 and this file's §7 "Real booking engine" note below.

---

## 7. Implementation notes (V1 build)

- **Session cookie** (`functions/_lib/session.ts`): `ck_session`, distinct from clienthub's `ch_session` so the two are never confused even though they'd never actually collide (different domains). Payload is `{workosUserId, issuedAt}` only — no role, no cached data — because every request re-queries the `users` table (`functions/_lib/roles.ts`) for the caller's *current* role. A revoked or changed role therefore takes effect on that person's very next request, not at cookie expiry. Max age is 12 hours (vs. clienthub's 30 days), a deliberate tighter window since this is an internal tool gating stage/offer mutations, not a client-facing portal.
- **Auth flow mirrors clienthub's exactly** (`functions/api/auth-{start,callback,logout}.ts`, `functions/_lib/workos.ts`), including `prompt=login` on the authorize URL for the same reason clienthub added it (never silently reuse an existing AuthKit browser session). The one structural difference: clienthub's callback links a *client* record; this app's callback looks up a *staff* row in `users` and rejects outright (`?error=not_staff`) if none exists — there is no self-service staff signup, by design (§1).
- **The generic stage-advance endpoint deliberately blocks two stages.** `functions/api/app/projects/[id]/advance.ts` enforces the plain forward-sequence map (`functions/_lib/stages.ts`, copied verbatim from clienthub, not shared as a package — see §0) but explicitly rejects `toStage: "offer_unlocked"` or `"essential_upsell"`. Those two moves only happen through `functions/api/app/offers/unlock.ts`, which creates the actual `offers` row and writes `offer_events` *before* advancing the stage — a bare stage flip with no offer row behind it would leave `clienthub`'s client dashboard assuming an offer exists when it doesn't. This was verified live (see §5): attempting `offer_unlocked` via the plain advance endpoint returns `400`, directing the caller to the unlock endpoint instead.
- **The frontend never re-derives the transition map.** `src/lib/stageLabels.ts`'s `NEXT_FORWARD_STAGE` is a small, presentation-only mirror (which single button to show for a given current stage) — the real enforcement is server-side in `advance.ts`/`override.ts`. The two offer-gated stages are deliberately absent from this map so no plain "advance" button ever renders for them; the contextual "Unlock ₱1,499 Offer"/"Unlock Next Offer" buttons in `ClientDetailPage.tsx` are gated on `project.stage` directly instead.
- **Recording an offer decision is a staff action, not a client one, in V1.** `functions/api/app/offers/[id]/decision.ts` lets staff record "accepted"/"declined" based on a decision communicated off-platform (chat, a call) — clienthub doesn't yet have a self-serve accept/decline UI of its own. Accepting the ₱1,499 offer is the one decision that moves the project forward on its own (`offer_unlocked` → `conversion`, a legal step in the forward sequence); declining does not auto-change the stage, since what happens next after a declined sale is a staff judgment call, not something this endpoint should guess at.
- **"Paid, no account yet" is a filter, not a separate nav item.** `GET /api/app/clients?paidNoAccount=1` and the "Resend Account Setup Email" button live on the same Clients page/detail view as everything else, since it's the same underlying `clients` record set (`invitation_status != 'accepted'`) — adding a whole separate screen for one filter condition would just fork the same data two ways.
- **"One way in" fix [2026-09-07]: `resend-invite.ts` no longer sends a WorkOS invitation.** It used to call the same `sendInvitation()` clienthub's ganap webhook called on first issuance — WorkOS's own `POST /user_management/invitations` emails an `accept_invitation_url` automatically, a second, WorkOS-controlled way into account creation alongside the marketing site's thank-you page button. A real client hit both at once and got confused about which was the real way in, so clienthub's webhook was changed to stop sending that invitation at all (see `clienthub/CLAUDE.md` §1 item 11). This button follows the same change: it now calls `functions/_lib/email.ts`'s `sendEmail()`/`accountReminderEmail()` (a duplicated copy of clienthub's own new email helper, same "reuse the pattern, not the code" convention as everything else shared between the two repos) to re-send a plain reminder pointing at `/api/auth-start?intent=signup` — the one real entry point — rather than asking WorkOS to create a second one. `sendInvitation()`/`WorkosInvitation` were deleted from this repo's `_lib/workos.ts` too (zero remaining callers). Requires `RESEND_API_KEY`/`RESEND_FROM_EMAIL` (hard-required here, unlike clienthub's best-effort webhook use of the same pair — a staff member clicking this button expects an email to actually go out, not a silent no-op).
- **Manual client notes vs. scheduled sessions.** `client_activity` (via `POST /api/app/clients/:id/activity`) is for free-text staff notes only. `scheduled_at`/`meeting_link` on `discovery_sessions`/`presentations` are a different kind of record entirely (structured booking state, not a note) and stay on those tables directly rather than being folded into the activity feed.
- **Real booking engine [2026-09-07].** Replaces the old interim call-request behavior (client submits a few preferred times as free text, staff calls manually) with a real shared calendar — see `clienthub/CLAUDE.md` §10 for the full design (the 45min/15min-buffer grid, the `slotsConflict` rule, Asia/Manila-fixed-offset math) and this app's slice of it specifically:
  - `functions/_lib/scheduling.ts` here is a **smaller** duplicate of clienthub's module — just the constants and `slotsConflict()`, not the full slot-grid generator, since staff enter a presentation's date/time directly rather than picking from a generated grid. The conflict rule is what lets that free-form time still get the same "no double-booking" guarantee the client's grid-constrained booking has, with no separate interval-overlap logic needed.
  - `GET/POST /api/app/availability` + `DELETE /api/app/availability/:id` (`functions/api/app/availability/`): plain CRUD on the shared weekly `availability_rules` table, no role restriction (matches this codebase's existing precedent — nothing anywhere restricts by specific staff role beyond "any authenticated staff"). Surfaced as a new **Availability** card on `SettingsPage.tsx`: rules grouped by day, a small add-rule form using `<input type="time">` (which already returns "HH:MM" in the exact format the backend expects, no parsing needed).
  - `discovery/[id].ts` and `presentations/[id].ts`'s `PATCH` both gained a `meetingLink` field (staff-set, client-visible via clienthub's `/api/client/me`) and now re-validate a staff-supplied `scheduledAt` against `slotsConflict()` (`409` on collision) — staff overriding a session's time directly is just as protected against double-booking as the client's own booking flow.
  - **`POST /api/app/presentations`** (new — this table previously had no creation endpoint at all, since only the now-removed client-side interim flow ever created one) creates the first presentation for a project: `{ projectId, scheduledAt, meetingLink? }`, conflict-checked against the shared grid, rejected `400` if the project already has one (update the existing row instead, via the `PATCH` endpoint above).
  - `ClientDetailPage.tsx`'s Presentation card now shows a `SchedulePresentationForm` (plain `datetime-local` + meeting-link input) when no presentation exists yet, or a `RescheduleField` + `MeetingLinkField` alongside the existing status/notes editor once one does. The Discovery card gained a `MeetingLinkField` too (discovery's `scheduled_at` is still client-set via clienthub's booking flow, never created here — staff can only edit an existing row's status/notes/link, matching the pre-existing behavior).
  - **Verified live, end to end**, against this app's own local `wrangler pages dev` + local D1 (seeded from `clienthub/d1/schema.sql`, gitignored `wrangler.toml`/`.dev.vars` deleted after the session, never committed): added an availability rule and confirmed it round-trips through `GET`; rejected an invalid rule (`end_time` before `start_time`, `400`); created a presentation at a time conflicting with an existing discovery session (`409`, correctly rejected) and at a clear time (`200`, correctly accepted); attempted a second presentation for the same project (`400`, correctly rejected); confirmed `GET /api/app/clients/:id` returns both tables' `meeting_link`. Playwright screenshots confirmed `ClientDetailPage.tsx` renders scheduled times/pre-filled meeting-link fields/reschedule input correctly, and `SettingsPage.tsx`'s Availability card lists/adds/removes rules correctly.
- **The dashboard's "today's counts" reads as today's *activity*, not current totals-by-stage.** CLAUDE.md's source spec (§20) lists "new clients, discovery, building, presentations, offers unlocked, conversions" without specifying which interpretation; `functions/api/app/dashboard.ts` counts *transitions into* each stage today (via `stage_history`/`offer_events` timestamps), since a running total-in-stage doesn't answer "what happened today" the way a daily ops dashboard needs to — the Projects/Clients pages already cover current totals.
- **Verified against a real local D1, not just code review** (see §5's Definition of Done for the exact scenarios exercised): schema applied from `clienthub/d1/schema.sql`, a staff `users` row and a test `clients`/`projects` row seeded by hand, then driven through `wrangler pages dev` with a gitignored `.dev.vars`/`wrangler.toml` pair (both deleted immediately after the test session, never committed, matching this project's established secrets discipline). This caught nothing wrong, but it's the difference between "the code looks right" and "the code was actually run."

---

## 8. Website URL + plan override [2026-09-07]

Two staff controls added to `ClientDetailPage.tsx`, both requested as part of clienthub's "Client Hub-ClientKeeper improvements" follow-up (see clienthub's CLAUDE.md §12/§13 for the client-facing side of both).

**Website URL** (`Project & Stage` card): a `WebsiteUrlField` input, shown only once a project reaches `post_presentation` or later (`POST_PRESENTATION_OR_LATER`, a local stage list mirroring `functions/_lib/stages.ts`'s `FORWARD_SEQUENCE` order — a workflow convenience for when a client would plausibly have a real site to link, not a security boundary). `POST /api/app/projects/:id/website` (`functions/api/app/projects/[id]/website.ts`) writes `projects.website_url` — the exact column clienthub's own `/api/client/me` already reads to show the client's live site link on their Dashboard and Website pages, so this is the one place that value comes from. No stage gating server-side (staff are already fully trusted, unlike clienthub's client-facing endpoints).

**Plan override** (`Plan` card, new): displays the client's current active plan/add-ons (`GET /api/app/clients/:id` now also returns `subscriptions`, active rows only, same shape as clienthub's `/api/client/me`) plus a dropdown (`PLAN_OPTIONS`, display-only ids/names matching `functions/_lib/pricing.ts`'s `PLAN_CATALOG`) and a "Set Plan" button. `POST /api/app/clients/:id/set-plan` (`functions/api/app/clients/[id]/set-plan.ts`) supersedes the client's current active plan (`status = 'cancelled'`, `ended_at = now`) and inserts a new active row — same shape and same supersede semantics as clienthub's ganap webhook's internal-upsell branch (`functions/api/webhooks/ganap.ts`, merged from a formerly-separate `internal-upsell.ts` on 2026-09-09 — see clienthub's CLAUDE.md §17), computing `renewal_amount_php`/`next_renewal_date` from the same catalog logic (`addInterval`). The critical difference: **this creates no payment and calls no ganap.net endpoint** — `payment_id` stays `NULL` on the new row, marking it staff-set rather than client-paid, purely for corrections/comps/data-entry fixes (e.g. a client who should have started on a different plan than the automatic Starter-Plan-on-signup default clienthub's ganap webhook now applies). Audited like every other sensitive admin action here (guardrail #3): writes both `audit_log` (`action: 'plan_override'`, before/after plan ids) and `client_activity` (visible in the Activity tab).

`functions/_lib/pricing.ts` here is a small, plans-only duplicate of clienthub's identically-named file (no add-ons — this app's override control only ever sets a *plan*) — same "reuse the pattern, not the code" convention as every other shared-concept module between these two repos (§0). Ids must match clienthub's catalog exactly.

**How this was tested:** live, end to end, against a local `wrangler pages dev` + local D1 seeded from `clienthub/d1/schema.sql` (gitignored `wrangler.toml`/`.dev.vars`, deleted after the session, never committed) — a staff user, a test client with an active Starter Plan row, then: `set-plan` to Business correctly cancelled the Starter row and inserted an active Business row with the right `amount_php`/`renewal_amount_php`/`next_renewal_date`, and wrote both an `audit_log` row (before/after) and a `client_activity` entry; `website` correctly wrote `projects.website_url`. A Playwright screenshot confirmed `ClientDetailPage.tsx` renders the website link + editable field and the Plan card's current-plan display + override dropdown correctly.

---

## 9. URL normalization + Basic plan pricing correction [2026-09-07]

Two small fixes discovered from real usage, paired with clienthub's CLAUDE.md §14:

- **Website URL scheme normalization.** A URL saved without a scheme (e.g. `imago.altasme.com`) previously rendered as a relative link on clienthub's client-facing pages — it opened `https://account.altasme.com/imago.altasme.com` instead of the real site. `functions/api/app/projects/[id]/website.ts` now prepends `https://` if the input doesn't already start with `http(s)://` before writing `projects.website_url` — this is the canonical fix (the one write path). `ClientDetailPage.tsx`'s own read-only link display (both the pre-post-presentation view and `WebsiteUrlField`'s preview) also normalizes defensively at render time, so a URL already stored without a scheme before this fix displays correctly here too without needing a re-save.
- **Basic plan pricing corrected** to match clienthub's catalog: `functions/_lib/pricing.ts`'s `PLAN_CATALOG` entry for `basic` changed from `{ billing: "one_time", chargeNowPhp: 1500, renewalPhp: 750 }` to `{ billing: "annual", chargeNowPhp: 1500, renewalPhp: 1500 }` — Basic is now ₱1,500/year (domain renewal for basic domains included), not a ₱1,500 one-time build plus a separate ₱750/year line. `ClientDetailPage.tsx`'s `PLAN_OPTIONS` override-dropdown label updated to match ("Basic Plan (₱1,500/yr)").

No change needed to the plan-override endpoint's own logic for either fix — `set-plan.ts` already reads whatever `findPlan()` returns, so it picked up the corrected Basic numbers automatically once the catalog changed. Staff overrides remain unrestricted by design (admins can freely move a client to any plan, including what would be a "downgrade" for a client acting on their own — clienthub's CLAUDE.md §14 covers the client-side half of that rule).

Verified live: setting a project's website URL to `imago.altasme.com` via `POST /api/app/projects/:id/website` correctly stored `https://imago.altasme.com`.

---

## 10. Em dash cleanup, staff-facing copy [2026-09-07]

Per the operator's instruction to remove em dashes everywhere, swept every rendered string (JSX copy, email subjects/bodies, placeholder offer content) in this repo, matching the same pass done in `clienthub` (see its CLAUDE.md §15.2). Fixed: `PaymentsPage.tsx`'s read-only note, `ClientDetailPage.tsx`'s discovery-empty-state line and stage-history reason annotation, the account-setup-reminder email subject in `functions/_lib/email.ts`, and the ₱1,499/Essential placeholder offer copy in `functions/api/app/offers/unlock.ts`. Left alone deliberately: the `"—"` used as a plain "no value" placeholder character in table cells across the Leads/Clients/Discovery/Presentations/Payments/Offers/Dashboard list pages — that's a data-display convention (missing value indicator), not prose punctuation, so it isn't what the em-dash rule targets. Rebuilt, linted, and typechecked afterward (all clean).

---

## 11. Manual client entry [2026-09-08]

The operator's request: "We should be able to add a client record manually." Until now the only way a `clients` row ever came into existence was clienthub's ganap.net webhook — no path for a client who paid outside ganap (bank transfer, cash, a comp) or a legacy/existing client being backfilled into the system for the first time.

**`POST /api/app/clients`** (added alongside the existing `GET` handler in `functions/api/app/clients/index.ts`): takes `fullName`, `businessName`, `email` (all required), optional `mobile`/`facebook`/`currentWebsite`, and an optional `initialStage` (defaults to `payment_received`, validated against the full stage set — `FORWARD_SEQUENCE` + `TERMINAL_STAGES` from `functions/_lib/stages.ts` — so a bad value 400s cleanly instead of hitting the `projects.stage` CHECK constraint). Mirrors clienthub's ganap webhook's client+project creation shape exactly: a `clients` row (`invitation_status: 'pending'`, `workos_user_id` NULL, same as any freshly-paid client) and a `projects` row at the chosen stage are created together, so a manually-added client behaves identically to a webhook-created one everywhere else in the app (Dashboard, Clients list, stage advance/override, plan override). Deliberately does **not** create a `payments` or `subscriptions` row — this endpoint records a client, not a payment or a plan; staff use the existing `set-plan` override separately if the client needs one.

**Duplicate protection:** a case-insensitive email match against existing `clients` returns `409` with the existing client's id in the body (`{ error, clientId }`) rather than silently creating a second record for the same person — `ApiError` in `src/lib/api.ts` was extended to carry the full error response body (not just `.message`) so the frontend can read `clientId` back out.

**Audited like every other write in this app** (CLAUDE.md §3 / guardrail #3): writes `stage_history` (`from_stage` NULL, `reason: "Client added manually"`, actor = the staff member), `client_activity` (`type: "manual_add"`), and `audit_log` (`action: "manual_client_add"`, `after` carrying the submitted fields) — the same three-write pattern `set-plan.ts` and `resend-invite.ts` already use for sensitive actions.

**Frontend:** `src/components/Modal.tsx` (new, copied from clienthub's own `Modal.tsx` — a small dialog with Escape-to-close and focus-on-open, kept as a separate copy per this repo's "deliberately independent apps" convention rather than a cross-repo import) and `src/components/AddClientModal.tsx` (the form itself, reusing `ALL_STAGES`/`STAGE_LABELS` from `src/lib/stageLabels.ts` for the stage dropdown). `ClientsPage.tsx` gained a "+ Add Client" button next to the page heading; on success the modal navigates straight to the new client's `/clients/:id` detail page rather than just closing, so staff land directly on the record they just created. On the 409 duplicate case, the error banner includes a "View existing client →" link straight to the pre-existing record.

**How this was tested:** live, end to end, against a local `wrangler pages dev` + local D1 instance (gitignored `wrangler.toml`/`.dev.vars`, deleted after the session, never committed) seeded from clienthub's shared `d1/schema.sql`. Verified via curl: `401` with no session, `400` for a missing name/bad email/unknown stage, `201` with correct `client`/`project`/`stage_history`/`client_activity`/`audit_log` rows on a valid request (confirmed the chosen `initialStage` — not just the default — landed correctly in `projects.stage` and `stage_history.to_stage`), and `409` with the existing client's id on a same-email retry (case-insensitively, `MARIA@...` matched `maria@...`). Playwright confirmed the full UI flow: the button opens the modal, the submit button stays disabled until all three required fields are filled, a successful submit navigates to the new client's detail page showing the correct stage, "Client added manually" in Stage History, and "manual_add: Client record added manually by staff" in Activity & Notes.

---

## 12. Bill of Service [2026-09-08]

The operator's request: a payment-request generator ("Bill of Service") — a branded, unique-link invoice with a fee breakdown and scope, sent to a client to pay via ganap.net, with its own tracking number, a configurable expiry, and a paid/pending/expired state the link itself reflects. This app owns *generating* one (a plain D1 write, no ganap.net credentials needed here at all — see clienthub's CLAUDE.md §16 for why creating a bill needs no payment-provider secrets, only paying one does); the public page and the actual ganap.net checkout/webhook live in `clienthub`, which already holds those credentials.

**New nav item "Billing"** (`/billing`, `/billing/new`, `/billing/:id`), between Offers and Payments.

- **`GET/POST /api/app/bills`**: list + create. Creating computes `bill_number` (`ALTAV-BOS-{Manila year}-{seq}`, zero-padded to 3 digits — `seq` is `COUNT(*) + 1` against bills already carrying that year's prefix, no transaction/retry, the same "good enough for a single-operator low-concurrency tool" tolerance already accepted elsewhere in this app, e.g. the manual-client-add duplicate-email check in §11) and a fresh `token` (deliberately *not* the human-readable `bill_number`, so the public link can't be guessed by incrementing a number in the URL, matching the operator's own "so it doesn't look scammy" requirement — originally a `crypto.randomUUID()`, shortened in §14 below). A bill can optionally link an existing `clients` row (`clientId`) or stand alone (a prospect who isn't a tracked client yet) — standing alone requires a `recipientEmail` in the request, since something has to reach ganap.net's `customerEmail` field at checkout time on the clienthub side; linking a client makes `recipientEmail` optional (falls back to the client's own email there). `clientType` (`individual`/`corporate`) is chosen fresh per bill rather than stored on the `clients` row itself, since in principle the same client could be billed once personally and once through a company. At least one line item (description + a positive whole-peso integer amount) is required; `totalAmount` is the sum, stored as a snapshot rather than recomputed on every read.
- **`GET /api/app/bills/:id`**: full detail (all fields + line items + the public link) for the detail page.
- **`POST /api/app/bills/:id/cancel`**: staff-only, only works on a `pending` bill (a `paid` one is done, `expired`/already-`cancelled` are rejected too, not just hidden in the UI) — flips to `cancelled`, after which the public link shows a cancelled state with no payment button. Audited the same three-write way as every sensitive action in this app (`audit_log` + `client_activity` when a client is linked).
- **`src/pages/BillingPage.tsx`**: the list, with a status filter and a one-click "Copy Link" per row (builds `https://account.altasme.com/bill/:token` client-side from the token the list endpoint already returns — no extra round-trip).
- **`src/pages/NewBillPage.tsx`**: the generator form — an optional client search-and-select (autofills recipient name/email, clearable back to a blank standalone entry), an Individual/Corporate toggle that reveals Contact Person/TIN fields only for Corporate, a dynamic line-item list (add/remove rows, live-computed total), validity-in-days (default 7), and an optional notes field. On success, navigates straight to the new bill's detail page.
- **`src/pages/BillDetailPage.tsx`**: full detail, a "Copy Link" + "View as Client" (opens the real public page in a new tab) pair, and the cancel action (a two-step inline confirm, matching this app's existing `OverrideControl` pattern in `ClientDetailPage.tsx` rather than a browser `confirm()` dialog).

**How this was tested:** the cross-repo local test described in clienthub's CLAUDE.md §16 — both apps' local D1 instances pointed at the same `--persist-to` directory and `database_id`, so a bill created here was immediately visible through clienthub's public endpoint on a different port, exactly like the one shared production database. Verified via curl: bill-number sequencing across multiple creates in the same year (`...-001`, `...-002`, `...-003`, `...-004`), validation 400s (no line items, no client + no recipient email, unknown initial-stage-style bad input), cancel correctly rejecting a non-pending bill and succeeding on a pending one. Playwright screenshots confirmed the Billing list (all four status badges), the detail page (payment link, recipient block with Attn/TIN for a corporate bill, line items, total), and the New Bill form (client search/select, the Individual/Corporate toggle revealing/hiding fields, the live total, the submit button staying disabled until required fields are filled).

---

## 13. Bill of Service fixes: optional email, a real line-item layout bug, and a live preview [2026-09-09]

Four issues reported after the operator actually used the feature, all in `NewBillPage.tsx` unless noted:

- **Recipient email is no longer required.** Previously a standalone (no linked client) bill couldn't be created without one, since it's what Client Hub's checkout passes to ganap.net as `customerEmail`. The operator's call: staff share the link manually anyway, so an email shouldn't gate bill *creation* — `canSubmit` and the backend validation (`functions/api/app/bills/index.ts`) both dropped the requirement (still format-checked if one *is* given, since a malformed address is worse than none). Client Hub's checkout (`functions/api/public/bill/[token]/checkout.ts` there) now falls back to a generic `billing@altasme.com` placeholder when neither the linked client nor `recipient_email` has one, instead of hard-failing with a 500 — see its CLAUDE.md §16 for the reasoning.
- **A real line-item layout bug, found by actually clicking through the form**: the description field rendered as a barely-visible sliver and the amount field stretched to fill almost the entire row — the opposite of the intended layout. Root cause: the shared `inputClass` bakes in `w-full`, and the line-item row applied `flex-1`/`w-32` *on top of* it — two classes both setting `width` directly, fighting each other in the same row. Fixed with a dedicated `rowInputClass` (identical styling, no `w-full`) for just the description/amount pair, plus `min-w-0` on the flex-1 description field (the same fix already documented for a similar two-column overflow bug on the marketing site's `FybHero.tsx` — flex items default to `min-width: auto`, which can force a row wider than intended even with `flex-1` set). Reproduced first with Playwright (filling three line items and screenshotting showed the squashed layout plainly) before fixing, then re-verified clean.
- **A live invoice preview**, added as a second column on the right (`grid lg:grid-cols-[minmax(0,1fr)_380px]`, sticky on scroll) — mirrors clienthub's actual public `BillPage.tsx` layout (header, No/Date/Terms, From/To with the same `ALTAVENTURES_TIN` constant duplicated here for consistency, scope + line items, total) so staff can see exactly what the client will see as they type, before ever saving. Since no bill exists yet at this point, the bill number reads "(assigned on save)" and the payment button is a non-interactive placeholder with a note that the real link appears after saving — this isn't a substitute for the actual detail-page link, just a WYSIWYG check while composing.
- **Confirmed link generation still works end-to-end** after the above changes: submitted a bill with no recipient email at all, followed through to its detail page, and verified the real `https://account.altasme.com/bill/:token` link renders with working "Copy Link"/"View as Client" actions — the original "it should create a link we can send" behavior was never actually broken, but is re-verified here given how much else in this pass touched the same form.

**How this was tested:** live, against the same cross-repo local setup as §12 (both apps' D1 pointed at one shared `--persist-to` directory, deleted after the session). Playwright drove the actual form — filled three line items, added/removed one, and screenshotted before and after the CSS fix to confirm the visual regression was real and then resolved; separately submitted a no-email bill through to its detail page and confirmed the public `GET` and `checkout` endpoints both behave correctly (checkout now reaches the actual ganap.net network call instead of failing on missing contact info first — it still 502s in this sandbox specifically, since `convex-top-api.ganap.net` is blocked here, the same limitation as every other ganap integration in this project).

---

## 14. Bill of Service: shorter shareable link [2026-09-09]

The operator's request: "Any chances of shortening the shareable link? Something like `https://altasme.com/Bill/(last 4 digits)`" — a bare `crypto.randomUUID()` token (36 characters) is unwieldy to paste into a chat message.

Two parts of the literal suggestion didn't survive as asked:
- **The domain stays `account.altasme.com`, not bare `altasme.com`.** The public bill page is served by `clienthub`, which lives on the `account.` subdomain; moving it to the apex domain (served by the marketing-site repo/Pages project) would be a cross-repo routing/infrastructure change, not a code fix in either app, and wasn't undertaken here.
- **"Last 4 digits" (10,000 combinations) was too short to keep the link's own security property.** The entire point of using a random token instead of the sequential `bill_number` (§12) is that one client can't guess another client's bill URL — a 4-character numeric suffix would make every other client's bill practically enumerable by script, directly undermining that "so it doesn't look scammy" requirement. Proposed and implemented an alternative that's still short enough to read aloud or paste comfortably: **8 characters from a fixed 32-symbol alphabet** (`23456789abcdefghjkmnpqrstuvwxyz` — digits 0/1 and letters l/o/i excluded to avoid visual confusion, lowercase-only so a chat app's autocapitalization can't mangle it on copy/paste). `32^8 ≈ 1.1 trillion` combinations, comfortably unguessable while being a third the length of the old UUID.

**Implementation, `functions/api/app/bills/index.ts`:** `generateShortToken()` draws `TOKEN_LENGTH` (8) random bytes via `crypto.getRandomValues()` and maps each to `TOKEN_ALPHABET` by `byte % 32` — bias-free since `256 % 32 === 0`. `generateUniqueToken(db)` calls it in a check-and-retry loop (up to 5 attempts, querying `bills` for an existing match each time) before falling back to a full `crypto.randomUUID()` in the astronomically unlikely case every retry collides. `onRequestPost` now calls `await generateUniqueToken(db)` instead of `crypto.randomUUID()` directly. Existing bills keep their original long UUID tokens unchanged — `token` is a plain unconstrained `TEXT` column on both sides (this app's write, clienthub's public lookup), so old and new-format tokens resolve identically; no migration needed.

**No changes needed in `clienthub`** — its `GET /api/public/bill/[token]` and `POST /api/public/bill/[token]/checkout` both just match `token` as an opaque string, regardless of length or format.

**How this was tested:** `npm run build`, `npm run lint`, and `npx tsc -p functions/tsconfig.json --noEmit` all passed clean. Then the same cross-repo local setup as §12/§13 (clienthub on :8788, clientkeeper on :8789, one shared `--persist-to` D1 directory, an HMAC-signed staff session cookie built by hand to skip a live WorkOS call) — created three bills via `POST /api/app/bills` and got three distinct 8-character tokens (`5uny4tu3`, `78948azy`, `9funtwum`); confirmed `GET /api/public/bill/5uny4tu3` on clienthub's dev server resolved the correct bill (200) and that a bogus-looking token (`zzzzzzzz`) correctly 404'd; took a Playwright screenshot of the ClientKeeper detail page showing the new link rendering cleanly on one line (`https://account.altasme.com/bill/5uny4tu3`). All test scaffolding (both `wrangler.toml`s, `.dev.vars`, `.wrangler/`, the shared persist directory, scratch scripts/screenshots) deleted afterward, nothing committed.

---

## 15. "Check Payment Status" — manual reconciliation for a stuck bill [2026-09-09]

Companion to clienthub's CLAUDE.md §18: once the live ganap.net project's Status & Retry API became available, `BillDetailPage.tsx` gained a "Check Payment Status" button (next to "Copy Link"/"View as Client", shown only while `status === "pending"`) so staff aren't stuck waiting on a webhook that might never arrive for a bill someone insists they already paid.

`src/lib/api.ts`'s `reconcileBillPayment(token)` deliberately does **not** go through this file's `apiFetch()` helper — it calls `https://account.altasme.com/api/public/bill/:token/reconcile` directly, cross-origin, with no cookies. That's a direct consequence of this app's own isolation design (§0): ClientKeeper holds no ganap.net credentials at all, so the actual status-check network call can only happen on clienthub's side, where those credentials live. The bill's own token is what gates the endpoint — same posture as the public bill page and its checkout endpoint, not a new auth mechanism.

On click: shows "Checking…", then either a plain status message (ganap says still pending/failed/expired, with clienthub surfacing its own webhook-delivery diagnostics under the hood) or, if ganap confirms paid, clienthub settles the bill server-side and this page reloads the bill detail to show the new `paid` state.

**How this was tested:** `npm run build`/`lint`/`tsc --noEmit` clean. See clienthub's CLAUDE.md §18 for the reconcile endpoint's own test coverage (the DB-side branches — no-reference, already-paid, unknown token — were exercised directly against a local `wrangler pages dev`; the actual outbound call to ganap.net can't be reached from this sandbox, same limitation as every other real ganap integration in this project, and correctly surfaces as a graceful error here rather than a broken button).

---

## 16. Payment flow audit, ganap minimum amount, and branding [2026-09-10]

Audited the full payment flow at the operator's request, to prepare it for commercial production use. Full writeup is in the marketing site's CLAUDE.md section 20; this section covers what changed in this app specifically.

**Added a ganap.net minimum transaction amount check.** The operator's own live 1 peso test on the marketing site surfaced a real gap: ganap.net enforces a 200 peso minimum, and nothing anywhere checked for it. `functions/api/app/bills/index.ts` now rejects a bill whose total is under 200 pesos at creation time, with a clear error, so staff learn about the floor immediately instead of a client hitting a mystery payment failure days later. `NewBillPage.tsx` mirrors the same check client side (disables the submit button, shows the same message under the live total) so staff see the problem before ever hitting submit. A matching safety net was added on clienthub's side too (see its CLAUDE.md section 19), for any bill created before this check existed.

**Branding: this app had none until now.** No logo, no favicon, anywhere. Added `public/images/brand/altaventures-logo.png` (copied from the marketing site's own asset) and `public/favicon.png`, wired into:
- `index.html`'s `<link rel="icon">`.
- `Layout.tsx`'s sidebar header, replacing the old plain text "Altaventures" eyebrow above the "ClientKeeper" label.
- `NewBillPage.tsx`'s `BillPreview` component, which mirrors the public bill page's layout for staff to check before saving. Added the same logo eyebrow there for one to one fidelity with what a client actually sees.

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. The logo rendering was checked visually via a standalone screenshot at the exact heights used, since most of this app sits behind staff login this sandbox cannot complete.

---

## 17. Starter Plan price raised from ₱299 to ₱499 [2026-09-11]

Companion to clienthub's CLAUDE.md §20 and the marketing site's CLAUDE.md §21: the operator raised the /foryourbusiness offer's price from ₱299 to ₱499.

**Changed:**
- `functions/_lib/pricing.ts`: this app's own copy of the `starter` catalog entry's `chargeNowPhp` is now 499.
- `src/pages/ClientDetailPage.tsx`: the staff-facing "Set Plan" override dropdown's Starter label changed from "Starter Plan (₱299)" to "Starter Plan (₱499)".

**Left unchanged, deliberately:** `functions/api/app/clients/[id]/set-plan.ts`'s header comment quotes the operator's own original instruction verbatim ("All clients start at starter plan 299, but we have to be able to override it"). That is a direct quote of something the operator actually said, not a live price statement, so it stays as originally written rather than being edited to match the new number.

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Grepped the whole repo for "299" before and after to confirm only the deliberately-kept quote remains.

---

## 18. Fixed a real focus-stealing bug in Add Client [2026-09-13]

Operator report: "I can't add a client manually. There's an issue," clarified as "I click on a field, then it glitches / bugs." Investigated the whole path first (`AddClientModal.tsx`, `POST /api/app/clients`, the auth middleware, the D1 schema) and reproduced the intended flow locally end to end against a fresh schema (every stage, including terminal ones) with no failure, which ruled out the backend entirely. The bug was in the shared `Modal.tsx` component instead, and had nothing to do with the database.

**Root cause:** `Modal.tsx`'s focus/Escape-key effect was keyed on `[open, onClose]`. `AddClientModal.tsx` passes an inline `onClose={() => setAddOpen(false)}`-shaped callback (`handleClose`, redefined fresh on every render, no `useCallback`), and typing into any field updates `AddClientModal`'s own local state (`fullName`, `businessName`, etc.), which re-renders it on every keystroke. Each re-render created a new `onClose` reference, which re-ran the effect, which called `closeButtonRef.current?.focus()` again, yanking focus off whatever field the user just typed into and onto the modal's close button, every single keystroke. In practice: click a field, type one character, focus jumps to "Close," and every character after that goes nowhere. Exactly the reported symptom.

**Fix:** the effect now depends on `[open]` only. `onClose` is read through a ref (`onCloseRef`, updated on every render but not part of the dependency array) so the Escape-key handler always calls the current `onClose` without needing the effect itself to re-run when that reference changes. The initial-focus behavior (moving focus to the close button when the dialog opens) still works exactly the same, it just no longer refires on every keystroke.

**How this was verified, not just reasoned about:** built a throwaway Vite entry point (`scratch-harness.tsx`/`.html`, deleted afterward, never committed) that renders `AddClientModal` inside a parent that re-renders on its own, mirroring `ClientsPage.tsx`'s exact prop-passing shape without needing auth or routing. Used Playwright to click the "Client Name" field and type "Juan": against the original code, `document.activeElement` after typing was the Close button and the field had captured only the first character ("J"); against the fix, focus stayed on the input and the full string typed correctly ("Juan"). Confirmed the regression is real by stashing the fix and re-running the identical test before restoring it. `Modal.tsx` has no other current callers, so this fix doesn't touch any other flow.

---

## 19. Starter Plan price reverted from ₱499 back to ₱299 [2026-09-16]

Companion to clienthub's CLAUDE.md §21 and the marketing site's CLAUDE.md §23: the operator reverted the /foryourbusiness offer's price back to ₱299, five days after the §17 raise.

**Changed:**
- `functions/_lib/pricing.ts`: this app's own copy of the `starter` catalog entry's `chargeNowPhp` is 299 again.
- `src/pages/ClientDetailPage.tsx`: the staff-facing "Set Plan" override dropdown's Starter label reverted from "Starter Plan (₱499)" back to "Starter Plan (₱299)".

**Left unchanged, same as §17:** `functions/api/app/clients/[id]/set-plan.ts`'s header comment still quotes the operator's original instruction verbatim ("All clients start at starter plan 299..."), unaffected either way since it already said 299.

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Grepped the whole repo for "499" afterward and confirmed no Starter Plan price mention remains at that number (the unrelated ₱1,499 domain-upsell offer elsewhere in this app is untouched, it was never part of this price change either direction).

---

## 19. Client Detail improvements: delete, placeholder plans, dates, WSA email [2026-09-16]

Four operator-requested additions to `ClientDetailPage.tsx`, all following this codebase's existing patterns (staff-only, audited via `audit_log` + `client_activity`, no new role restriction — nothing anywhere in this app gates by specific staff role beyond "any authenticated staff," per §7's existing precedent, so none of the four are restricted to `owner`/`admin` specifically despite the request's casual "Admin should be able to..." phrasing).

**1. Delete client records.** `DELETE /api/app/clients/:id` (`functions/api/app/clients/[id].ts`) is a genuinely destructive, irreversible action, so it's implemented carefully rather than relying on database `ON DELETE` behavior (D1 enforces the foreign keys `d1/schema.sql` declares, and several tables reference `clients`):
- **Deleted outright** (has no meaning once the client it describes is gone): `projects` and everything under it (`stage_history`, `discovery_sessions`, `presentations`), `offers` and `offer_events`, `subscriptions`, `client_activity`, `businesses`.
- **Preserved, not deleted**: `payments` (no FK to `clients` at all — see `d1/schema.sql`'s own note on why that constraint was dropped after a real orphaned-data incident — so these rows are simply left as-is, tolerating the orphaned reference the schema already documents) and `bills` (`client_id` DOES have a declared FK, so it's set to `NULL` first; the bill itself, its line items and payment history, is real money that happened and must survive deleting the client record it was raised against).
- Every statement runs inside a single `db.batch()` call for atomicity — either the whole cascade lands or none of it does. The `audit_log` row (`action: 'client_deleted'`, `before` = a full JSON snapshot of the `clients` row) is written inside the same batch, captured from a `SELECT *` taken just before the batch runs, since by the time it commits the client row itself is gone; `audit_log.entity_id` has no FK back to `clients`, so this row is the one place the deletion stays reconstructable afterward.
- **Frontend**: a "Danger Zone" card (`DeleteClientControl` in `ClientDetailPage.tsx`) requires typing the client's exact business name to enable the delete button — the same "type to confirm" pattern used for genuinely destructive actions elsewhere, stricter than the existing `OverrideControl`'s free-text reason since there's no undo here. On success, `ClientDetailPage.tsx` navigates to `/clients` instead of reloading the (now-gone) detail view.
- `lib/api.ts`'s `deleteClient(id)` is a plain `DELETE` call, no body.

**2. "Free Plan" and "299 Plan" placeholder catalog entries.** `functions/_lib/pricing.ts`'s `PLAN_CATALOG` gained two entries, ids `"free"` (₱0) and `"299"` (₱299), both `billing: "one_time"` with no `renewalPhp` — meaning `set-plan.ts`'s existing `plan.renewalPhp ? addInterval(...) : null` logic already makes them "do nothing" for free, with no new code needed: setting either one records a subscription row (name/amount snapshot, for display and audit consistency with a real purchase) but computes no renewal date, same as any other `renewalPhp`-less plan already would. **Deliberately ClientKeeper-only, not added to clienthub's matching catalog** — clienthub's `AccountPage.tsx` already handles an unrecognized `itemId` gracefully (`findPlan()` returns `undefined`, it just skips the "included features" list and still renders the stored `itemName`/amount snapshot correctly), so there's no real reason to duplicate two placeholder ids into a second catalog that has no purchase flow leading to them anyway. `PLAN_OPTIONS` in `ClientDetailPage.tsx` got the matching two dropdown entries, listed first.
- Note: "299 Plan" is a separate catalog id from the existing "Starter Plan" despite both being ₱299 — that duplication was requested as-is (a distinctly labeled placeholder, not a rename of Starter), not something this pass second-guessed.

**3. Domain expiration date + plan renewal date, staff-editable.** New nullable columns on the shared `clients` table (`domain_expires_at`, `plan_renewal_date` — see clienthub's `d1/schema.sql`/CLAUDE.md §22, since that's the canonical schema copy) plus `POST /api/app/clients/:id/set-dates` (`functions/api/app/clients/[id]/set-dates.ts`). Deliberately separate from `subscriptions.next_renewal_date` (§8's auto-computed field, tied to a subscription row and only meaningful for plans with a real `renewalPhp`) — these two are plain staff-typed record-keeping, settable for any client regardless of subscription state, and independently correctable without resetting plan history through "Set Plan". Both fields are optional independently in the request body (send only the one that changed) and nullable (send `null` or `""` to clear one); `normalizeDate()` distinguishes "field not sent, leave unchanged" (`undefined`) from "clear this field" (`null`/empty string). Audited the same way as every other mutation here: `audit_log` (before/after both fields) + `client_activity`.
- **Frontend**: a new "Dates" card (`DatesBlock`) with two `<input type="date">` fields and a single "Save Dates" button that sends both current values together.
- **This is a genuine schema migration on the live database**, same caveat as every prior `ALTER TABLE` note in clienthub's CLAUDE.md — see that repo's §22 for the exact statements to run before deploying this.

**4. Send Website Service Agreement link by email.** `POST /api/app/clients/:id/send-wsa` (`functions/api/app/clients/[id]/send-wsa.ts`), mirroring `resend-invite.ts`'s structure exactly: looks up the client's email/name/business from their record, sends via the shared `functions/_lib/email.ts` (`wsaAgreementEmail()`, new helper alongside the existing `accountReminderEmail()`), and logs `audit_log` (`action: 'wsa_link_sent'`) + `client_activity` only on a successful send — a failed Resend call returns `502` with nothing logged, so the activity feed never claims an email went out that didn't. Points at `https://altasme.com/WSA-free`, the marketing site's own standalone e-signature route (altaventureswebsite's CLAUDE.md §17) — unlinked from that site's nav, reached only by direct URL, so staff previously had to hand this link to a client manually (chat, verbally). Re-sendable as often as staff want, same reasoning as `resend-invite.ts`: no "already sent"/"already signed" state exists on this side of the system to gate on (clienthub has no record of WSA signing at all — that flow lives entirely on the marketing site's own `/api/submit-wsa`).
- **Frontend**: a "Send Website Service Agreement" button added to the Identity card, next to the existing "Resend Account Setup Email" button.
- Requires `RESEND_API_KEY`/`RESEND_FROM_EMAIL`, same as `resend-invite.ts`.

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Then live, end to end, against a local `wrangler pages dev` + local D1 (schema applied from clienthub's updated `d1/schema.sql`, seeded with a staff user and a test client carrying one of everything — a project, an offer + offer_event, stage_history, discovery/presentation rows, a subscription, client_activity, a business, a payment, and a bill; gitignored `wrangler.toml`/`.dev.vars`, both deleted after the session, never committed; a hand-constructed session cookie signed with the same HMAC scheme as `functions/_lib/session.ts`):
- `set-dates`: a full update, a partial update (only one field, confirmed the other was left untouched), and a `null` clear all round-tripped correctly through a subsequent `GET`.
- `set-plan` with `planId: "free"` and `planId: "299"`: both inserted the correct name/amount snapshot with `next_renewal_date: null`, confirming the "does nothing" requirement.
- `send-wsa`: a nonexistent client correctly returned `404`; a real client with a deliberately-fake `RESEND_API_KEY` correctly returned `502` from the Resend call failing, and confirmed via a follow-up `GET` that no `client_activity`/`audit_log` row was written for the failed attempt (this sandbox can't reach Resend's real API, same limitation already noted for this file's other email-sending endpoints elsewhere in this project's history, so the actual delivery itself wasn't verifiable here).
- `DELETE`: seeded row counts confirmed present beforehand for every related table; after calling delete, `projects`/`offers`/`offer_events`/`stage_history`/`discovery_sessions`/`presentations`/`subscriptions`/`client_activity`/`businesses` all correctly dropped to 0, the `payments` row survived with its `client_id` left pointing at the now-deleted id (the documented orphan-tolerance), the `bills` row survived with `client_id` correctly `NULL`ed, and the `audit_log` row's `before` snapshot correctly captured the client's final state (including the dates set earlier in the same test run). A delete of a nonexistent client returned `404`; an unauthenticated `DELETE` returned `401`, confirming the shared `_middleware.ts` gate still applies to the new route with no extra wiring needed.

---

## 20. Correction: domain field is a registration date, expiration is computed + a reminder email [2026-09-16]

§19 item 3 above was built against the wrong field: the operator clarified right after that staff actually input the domain's **registration** date, and expiration is always registration + 1 year — not a separately-tracked expiration date. Caught before ever deploying (see clienthub's CLAUDE.md §23 — this never reached a live database, so it's a clean rename, not a data migration), plus the operator asked for a renewal reminder email while correcting this, which didn't exist in §19 at all.

**Renamed throughout:** `clients.domain_expires_at` → `domain_registered_at` (schema in clienthub's `d1/schema.sql`, see its CLAUDE.md §23 for the corrected `ALTER TABLE` statements to run against the live database), `set-dates.ts`'s `domainExpiresAt` request/response field → `domainRegisteredAt`, `ClientDetailPage.tsx`'s `DatesBlock` prop/state, `lib/api.ts`'s types.

**Expiration is computed, never stored**, so it can't drift from the registration date if that's later corrected. `functions/_lib/email.ts`'s `computeDomainExpiration()` (registration + 1 year, same `setUTCFullYear()` approach as `set-plan.ts`'s existing `addInterval()`) is the one source of truth; `ClientDetailPage.tsx`'s `DatesBlock` duplicates the identical 3-line function for the live preview shown under the registration date input (`"Expires <date>"`), rather than round-tripping to the server just to display a pure function of a value already on the page.

**New: "Send Domain Renewal Reminder" button.** Manual only, per the operator's explicit preference over an automatic scheduled reminder — this app has no cron infrastructure to hang a "check everyone's expiration daily" job off of, and a manual button matches every other email action already in this file (Resend Account Setup, Send WSA). `POST /api/app/clients/:id/send-domain-reminder` (`functions/api/app/clients/[id]/send-domain-reminder.ts`) mirrors `send-wsa.ts`'s structure exactly, plus one extra guard: `400`s with "No domain registration date on record for this client" if `domain_registered_at` is unset, since there's nothing to remind anyone about. `domainRenewalReminderEmail()` (new, alongside `accountReminderEmail()`/`wsaAgreementEmail()` in `functions/_lib/email.ts`) computes the expiration date at send time and states it plainly in the email body. The button itself only renders once `domainRegisteredAt` has actually been *saved* (not just typed into the still-unsaved input), so staff can't hit the same 400 the server would return.

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Grepped the repo for the old `domain_expires_at`/`domainExpiresAt` names afterward and confirmed zero remaining references. Live, end to end, against a fresh local `wrangler pages dev` + local D1 (schema re-applied from clienthub's corrected `d1/schema.sql`; gitignored `wrangler.toml`/`.dev.vars`, deleted after the session, never committed): `send-domain-reminder` on a client with no registration date correctly returned `400`; `set-dates` with `domainRegisteredAt` correctly wrote and round-tripped the renamed column; `send-domain-reminder` afterward correctly passed validation and reached the (deliberately fake, sandbox-unreachable) Resend call, returning `502` with no `audit_log`/`client_activity` row written for the failed attempt, matching `send-wsa.ts`'s existing behavior. `computeDomainExpiration()`'s date math was checked directly against a plain registration date, a year boundary, and a leap-day input (`2024-02-29` → `2025-03-01`, JS `Date`'s standard rollover, accepted as-is rather than special-cased).

**Real deployment snag on the operator's live database, documented for the record:** the operator had already run §19's original `ALTER TABLE clients ADD COLUMN domain_expires_at TEXT; ALTER TABLE clients ADD COLUMN plan_renewal_date TEXT;` before this correction landed, then hit `duplicate column name: plan_renewal_date` attempting the corrected pair as a second statement — expected, not a bug, since `plan_renewal_date` was already there and unaffected by the rename. Live database now needs only `ALTER TABLE clients ADD COLUMN domain_registered_at TEXT;` (a duplicate-column error on that one line means it's already present too, nothing further to do); the old `domain_expires_at` column is a harmless permanent orphan, droppable at leisure via `ALTER TABLE clients DROP COLUMN domain_expires_at;`. See clienthub's CLAUDE.md §23 for the full writeup.

---

## 21. Added "Partnership Arrangement" placeholder plan [2026-09-17]

A third no-op placeholder plan, same treatment as "Free Plan"/"299 Plan" (§19): `{ id: "partnership", name: "Partnership Arrangement", billing: "one_time", chargeNowPhp: 0 }` in `functions/_lib/pricing.ts`'s `PLAN_CATALOG`, and a matching `PLAN_OPTIONS` entry in `ClientDetailPage.tsx` ("Partnership Arrangement (no fixed price)"). Confirmed with the operator before building: this plan has no fixed price to record — the real commercial terms of a given partnership arrangement live off-system (staff notes/activity log), this is purely a label so a client can be marked as under one. Same "does nothing" mechanics as the other two placeholders: `chargeNowPhp: 0` and no `renewalPhp` means `set-plan.ts`'s existing `addInterval()`-if-`renewalPhp` logic computes no renewal date, with zero new server-side code needed. ClientKeeper-only, not added to clienthub's catalog, same reasoning as §19 (`AccountPage.tsx` already tolerates an unrecognized `itemId` gracefully).

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Verified live against a local `wrangler pages dev` + local D1 (gitignored `wrangler.toml`/`.dev.vars`, deleted after the session): `set-plan` with `planId: "partnership"` correctly inserted a subscription row with `item_name: "Partnership Arrangement"`, `amount_php: 0`, and `next_renewal_date: null`.

---

## 22. MyCafe POS integration — a second, unrelated product line [2026-09-21]

The operator's request: feed MyCafe POS (a separate multi-tenant Cloudflare-based cafe POS SaaS, `altasme/mycafe-pos-system`, own repo/deploy) signups into ClientKeeper as a second client category, so there's one CRM view across both of Altaventures' product lines — and let staff generate that product's device activation tokens from here instead of a separate tool.

**Why this doesn't touch the existing stage machine.** MyCafe's own lifecycle (a cafe signs up → pays → gets provisioned → is an active tenant) doesn't map onto web_dev's `discovery → building → presentation → offer_unlocked → conversion` funnel at all — there's no discovery call, no presentation, no offer to unlock. Forcing a MyCafe client through `projects`/`stage_history` would be a fiction with no real meaning. A MyCafe client is a `clients` row with `product = 'mycafe_pos'` and **no `projects` row at all** — the schema already allows a client to exist without one (nothing enforces the reverse FK), this is just the first time that's used on purpose.

**Schema** (clienthub's `d1/schema.sql` is canonical — this is a genuine live-database migration, same caveat as every prior `ALTER TABLE` note in this file; I have no way to apply it myself, no wrangler/Cloudflare access from this session, same limitation MyCafe's own repo notes for itself):
```sql
ALTER TABLE clients ADD COLUMN product TEXT NOT NULL DEFAULT 'web_dev';
ALTER TABLE clients ADD COLUMN mycafe_cafe_id TEXT;
ALTER TABLE clients ADD COLUMN mycafe_status TEXT;
ALTER TABLE clients ADD COLUMN mycafe_slug TEXT;
ALTER TABLE clients ADD COLUMN mycafe_store_name TEXT;
```
Run this against the shared database before deploying this change (same "paste into D1 Console as separate statements if the console rejects a multi-statement paste" note as every other schema change here). **`clienthub/d1/schema.sql` itself hasn't been updated with these columns** — I only have read access to that repo, not push; whoever owns it should add a matching note there for documentation parity, same as every other cross-repo schema note in this file.

**Backend** (`functions/_lib/mycafe.ts`, `functions/api/app/mycafe/clients/{index,[id]/provision,[id]/new-device}.ts`): a small fetch-based client for MyCafe's control-plane admin API (`provisionMyCafeCafe`, `mintMyCafeDevice`), same "duplicate the pattern, not the code" convention as `_lib/email.ts` — MyCafe is a separate product with its own repo, not something to cross-import. Needs two new Cloudflare Pages environment variables/secrets, same discipline as `RESEND_API_KEY`/`WORKOS_API_KEY` (set in the dashboard, never committed):
- `MYCAFE_ADMIN_API_TOKEN` — the exact same bearer token MyCafe's own control-plane `/admin/*` routes require everywhere else (its `ADMIN_API_TOKEN` secret).
- `MYCAFE_CONTROL_PLANE_URL` — MyCafe's control-plane Worker URL (e.g. `https://mycafe-control-plane.<subdomain>.workers.dev`).

All three new routes sit under `/api/app/mycafe/*`, so the existing `_middleware.ts` WorkOS-session-plus-D1-role gate already covers them with no extra wiring — same as every other route in this tree.

- `POST /api/app/mycafe/clients` — creates the `clients` row only (`product = 'mycafe_pos'`, no `projects` row), from a name/business/email/store-name/slug form. Same duplicate-email `409` + `clientId` pattern as the existing manual client-add endpoint (§11).
- `POST /api/app/mycafe/clients/:id/provision` — calls MyCafe's `POST /admin/cafes` (first call) or `POST /admin/cafes/:id/provision` (a resume, if `mycafe_cafe_id` is already on file — MyCafe's own provisioning is idempotent/resumable, see its BACKEND.md) and records the returned `cafeId`/`status`. **The response includes the plaintext `deviceActivationToken` exactly once and this app never stores it** — same rule MyCafe's own API follows for the same value; a resume call returns no token at all, since that step already ran on MyCafe's side.
- `POST /api/app/mycafe/clients/:id/new-device` — mints an *additional* device token for an already-active cafe (MyCafe's own `POST /admin/cafes/:id/devices`, added to MyCafe specifically because a device token can't be recovered after the fact). Same one-time-return rule.

**Frontend**: a new "MyCafe POS" nav entry (`src/components/Layout.tsx`), grouped under its own "Products" heading below the web_dev nav items rather than interleaved with them — a different product, not one more step in the existing funnel. `src/pages/MyCafePage.tsx` lists MyCafe clients with a status badge (`not provisioned` / `provisioning` / `active`) and, per row, either a "Provision" / "Resume provisioning" or "New device token" button depending on status. A successful provision/new-device call shows the token in a dismissible green banner at the top of the page — `select-all` styled so staff can double-click to select it fully before copying — and the page states plainly that it won't be shown again. `src/components/AddMyCafeClientModal.tsx` mirrors `AddClientModal.tsx`'s structure, with a slug field that auto-derives from the business name (editable, since MyCafe requires it to be unique and URL-safe) instead of the web_dev form's stage picker.

**Owner email must match exactly.** MyCafe's own WorkOS owner-login flow (its BACKEND.md's "Staff identity" section) checks the authenticating WorkOS user's email against the cafe's registered `owner_email` before granting access — the add-client form says so directly, since a mismatch there is a MyCafe-side 403 this app has no visibility into after the fact.

**How this was tested:** `npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. **Not exercised live** — unlike every prior entry in this file, this session has no Cloudflare/wrangler access at all (no `wrangler pages dev`, no local D1, no way to reach either app's real deployment), so none of this has been run against a real database or a real MyCafe control-plane. Flagged rather than hidden, matching this project's own convention for caveats like this: before relying on it, run the schema migration above, set the two new environment variables, and click through creating a MyCafe client, provisioning it, and minting a second device token against a real (ideally MyCafe's own disposable dry-run) cafe.

---

## 23. Proposal Generator & Custom Questionnaire Builder [2026-10-15]

A full feature per the operator's own spec ("CLAUDEproposalquestionnaire.md"): per-client e-signature proposals and custom-field questionnaires, authored and managed from here, with the client-facing signing/filling experience hosted on the marketing site instead of this app.

### 23.1 Architecture: why this is split across three repos

The spec's own requirement — public URLs at the literal `https://www.altasme.com/proposal/{client}` and `/questions/{client}` — conflicts directly with this app's own "zero public endpoints, all client-facing traffic lives in clienthub" guardrail (CLAUDE.md's own opening architecture note). Neither `account.altasme.com` (clienthub) nor this app's own domain is `www.altasme.com` either, so the spec's literal URL requirement doesn't map onto the existing two-repo split at all. This was surfaced to the operator directly (not assumed), with three options; the operator chose the literal marketing-site domain ("to keep things simple"). The resulting split:

- **ClientKeeper (this repo) — admin/authoring backend.** Every create/edit/publish/revoke/review action is a new authenticated endpoint here, gated by the existing `_middleware.ts` WorkOS-session-plus-D1-role check with zero new wiring needed (every new route sits under the already-covered `/api/app/*` tree). This is the only place a proposal or questionnaire can be created or edited.
- **clienthub — schema owner only.** No functional code changed there; it only gained the new tables in its canonical `d1/schema.sql`, per this project's established "schema lives in clienthub even when the feature's real code lives elsewhere" convention (the MyCafe POS precedent, §22 above). See clienthub's own CLAUDE.md §24 for that side.
- **altaventureswebsite — public page host.** A previously fully static, database-free site gained its first-ever D1 binding and a handful of public, unauthenticated Cloudflare Pages Functions, specifically because `www.altasme.com` is that repo, not this one. See altaventureswebsite's CLAUDE.md §59 for the public-page implementation (`ProposalPage.tsx`, `QuestionsPage.tsx`, `functions/api/public/*`).

This repo never calls the public site's Functions directly and vice versa — the only thing connecting the two sides is the one shared D1 database, read and written independently by each app's own endpoints, same "duplicate the pattern, not the code, share only the database" convention this project already uses between clienthub and ClientKeeper themselves.

### 23.2 Data model: a draft buffer plus immutable published versions

Both proposals and questionnaires follow the same shape, designed specifically to satisfy the spec's two seemingly-opposed requirements — staff can freely edit at any time, but a signed proposal or a submitted questionnaire response must never silently change:

- **`proposals`** carries a live, directly-editable `title`/`content_html` (the draft buffer) plus a `status` (`draft → published → sent/signed/declined/expired/revoked`) and a `current_version` counter. **"Publish"** snapshots the current draft into a new, immutable `proposal_versions` row and bumps `current_version` — the draft buffer itself is untouched and keeps accepting edits. **`proposal_signatures`** rows point at the exact `proposal_versions.id` that was actually signed, never at the parent proposal or "whatever's current" — so a later revision can never retroactively change what a signature legally attached to.
- **`questionnaires`** works the same way, but the draft/version split lives one level down: `questionnaire_questions` rows with `version_id IS NULL` are the live, freely reorderable/editable draft question set; "Publish" copies every current `NULL`-version row into fresh rows stamped with a new `questionnaire_versions.id`, leaving the draft set untouched for further editing. `questionnaire_responses`/`questionnaire_answers` resolve against the exact `version_id` a client actually answered, so editing the live draft after someone has already submitted can never misalign or relabel their existing answers.
- **Revision after signing is a designed, supported path, not an edge case to block.** Publishing a new version of an already-`signed` proposal resets its status back to `published` (requiring a fresh signature) but never touches the original `proposal_signatures` row — the old signature stays bound to the old version forever. I caught and fixed a real bug here during review: the PATCH draft-update endpoint originally rejected any edit to an already-signed proposal with a 409, which would have made this designed revision flow impossible to reach in the first place; removed that block (editing the draft is now always allowed; `publish.ts` is the only place that resets status/requires re-signing) and found the identical mistake mirrored in `ProposalEditorPage.tsx`'s UI (a `locked` flag disabling the title/questionnaire-select/editor once signed) — fixed there too, replacing it with a plain explanatory note instead of disabling anything.

### 23.3 New backend routes (all under the existing `/api/app/*` auth gate)

- `GET/POST /api/app/clients/[id]/proposals` — list (with a computed `publicUrl` built from the slug+token) / create a draft.
- `GET/PATCH /api/app/clients/[id]/proposals/[proposalId]` — full detail (incl. every version and the latest signature, with its signature image/IP for the admin viewer) / draft update (title, content, linked questionnaire).
- `POST .../proposals/[proposalId]/publish` — snapshot + status transition, described above.
- `POST .../proposals/[proposalId]/revoke` — sets `revoked`, 409 if already revoked.
- `GET/POST /api/app/clients/[id]/questionnaires`, `GET/PATCH .../[questionnaireId]`, `PUT .../[questionnaireId]/questions` (atomic full replace of the draft question set, validating `field_type` against the 9-value enum and requiring ≥1 option for choice-based types), `POST .../[questionnaireId]/publish` (400 if zero draft questions), `POST .../[questionnaireId]/revoke`, `GET .../[questionnaireId]/responses` (resolved against each response's own `version_id`, never the live draft).

### 23.4 New frontend

- `src/components/RichTextEditor.tsx` — a deliberately lightweight `contentEditable` + `document.execCommand` rich-text editor (bold/italic/underline/headings/lists/link/table), not a framework (Tiptap/Slate/Quill) — judged to cover the spec's required formatting set at a fraction of the dependency weight for what's still an internal single-operator authoring tool.
- `src/pages/ProposalEditorPage.tsx` (`/clients/:clientId/proposals/:proposalId`) — title, status badge, public-link card (copy/view-as-client/revoke), signature card (signer/date/signature image/IP + a **Download Signed Copy** button, see §23.5), questionnaire-link selector, the rich-text editor with an Edit/Preview toggle, version history, Save Draft / Publish.
- `src/pages/QuestionnaireEditorPage.tsx` (`/clients/:clientId/questionnaires/:questionnaireId`) — title/description, a question-card list (field type, prompt, help text, options for choice types, required toggle, move up/down/duplicate/delete, all against local array state until saved), public-link card, version history, a lazy-loaded responses viewer, Save Draft / Publish.
- `src/pages/ClientDetailPage.tsx` gained two new cards ("Proposals", "Questionnaires") between the existing Offers and Payments cards, each self-fetching its own list with a "+ New…" button that creates a draft and navigates straight to its editor.

### 23.5 Download Signed Copy: a print-to-PDF document, not a generated PDF file

The spec requires a downloadable signed copy, but proposal content is free-form rich HTML with no fixed layout (unlike the `/WSA-free`/`/WSA-pro` agreements on the marketing site, which use `pdf-lib` to overlay fixed-position fields onto a pre-authored PDF template) — there's no template to overlay, and Cloudflare Pages Functions run in the Workers runtime with no Node/Chromium available to render arbitrary HTML to PDF server-side. `ProposalEditorPage.tsx`'s new "Download Signed Copy" button instead opens a new browser tab containing a clean, self-contained standalone HTML document (the exact signed content + the signature image + signer/date/IP, all already available from the already-loaded proposal detail, no new endpoint needed) and calls `window.print()` — the operator uses the browser's own "Save as PDF" print destination to get a real downloadable file. This is a pragmatic, standard web-native substitute for a generated-PDF pipeline, not a placeholder; it satisfies the real requirement (an exportable, signed, point-in-time copy of exactly what was agreed to) without inventing server-side HTML-to-PDF infrastructure this runtime can't support.

### 23.6 A real bug found during browser verification: the rich text editor rendered blank on load

Backend/API-level curl testing (below) all passed, but a follow-up Playwright pass against the actual rendered `ProposalEditorPage` caught a real bug the curl tests couldn't see: opening an already-published proposal showed the "Proposal Content" editor completely empty, even though `contentHtml` was correctly loaded (confirmed via the API response directly). Root cause, in `RichTextEditor.tsx`: `const lastValue = useRef(value)` initialized its "have I already synced this value into the DOM" tracker to the prop's value **at mount time** — and because `ProposalEditorPage` only renders the editor once `proposal` has already loaded (there's a `Loading…` early return before that), `value` was already correct on the editor's very first render. The sync effect's guard (`if (value !== lastValue.current)`) compared the prop against itself and saw no change, so it skipped ever writing to `ref.current.innerHTML` — but the actual contentEditable `<div>` always starts with empty DOM content regardless of the `value` prop (nothing sets a `defaultValue`/`dangerouslySetInnerHTML` on it), so the editor rendered permanently blank until the next *real* external change. Fixed by initializing `lastValue` to `null` instead of `value`, so the first sync always runs once on mount. This is the kind of bug that's invisible to API-level testing and only shows up in a real rendered browser — a good argument for not skipping that step even when the backend tests all pass.

### 23.7 How this was tested

`npm run build`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Verified live, end to end, against a real (local) D1 instance — unlike the MyCafe POS entry above, this feature spans two repos that both needed to see the same data, so I set up two separate `wrangler pages dev` processes (this repo and altaventureswebsite) pointed at one shared local D1 `--persist-to` directory via matching `database_name`/`database_id` in each repo's own temporary, gitignored `wrangler.toml`/`.dev.vars` (both deleted after the session). Seeded test data and a hand-built, correctly HMAC-signed `ck_session` cookie, then ran roughly 20 scenarios via curl covering: the auth gate (401/403 without a valid staff session); full proposal and questionnaire CRUD; the publish → version-snapshot → signature → **revise-while-signed** lifecycle (confirmed the original signature survives a republish untouched, and the public page correctly demands a fresh signature once the status resets to `published`); revoke/close idempotency (second revoke 409s); slug collision in two distinct scenarios (two different clients with the same business name; two proposals for the same client); required-field, URL-format, and duplicate-submission validation on the public questionnaire side; and rejection of publishing a questionnaire with zero draft questions. All scenarios passed on the first run after the two logic-bug fixes above were in place.

**Then did a real rendered-browser pass with Playwright against both new editor pages**, injecting a valid `ck_session` cookie directly rather than driving the WorkOS login flow: `ProposalEditorPage` and `QuestionnaireEditorPage` both screenshot-verified at 1280px desktop and 390px mobile, zero console/page errors at any point. This caught the rich-text-editor bug above (fixed, then re-verified the editor shows the real signed proposal content correctly); confirmed the Signature card, "Download Signed Copy" button, and the revise-while-signed amber note all render correctly once a proposal is signed; confirmed all 8 question-type editor rows (including options/required toggles per type) render correctly in `QuestionnaireEditorPage`; clicked "View Responses" and confirmed the real submitted answers render correctly against their questions; confirmed `ClientDetailPage`'s new "Proposals"/"Questionnaires" cards show the created records with correct status badges, "+ New…" buttons, and that every expected event (`proposal_created`, `questionnaire_created`, `questionnaire_published`, `proposal_published`, `proposal_signed`, `questionnaire_submitted`) appears correctly in the existing Activity & Notes log in the right order.

**One pre-existing, whole-app limitation surfaced by the mobile screenshot, not a regression from this feature:** at 390px, ClientKeeper's left sidebar (`Layout.tsx`) doesn't collapse or hide, squeezing all page content — on both new editor pages and on the already-shipped `ClientDetailPage` alike — into a narrow column with wrapped, cramped text. Confirmed this is identical on an existing, unrelated page (`ClientDetailPage`) at the same viewport, so it's a characteristic of the admin shell itself (seemingly never designed for a narrow viewport, consistent with this being an internal staff tool typically used on a desktop), not something this feature introduced or regressed. Flagged as a known limitation below rather than silently worked around, since fixing the whole app's responsive shell is a much larger, unrelated change from what this task asked for.

The one thing not exercised live: a real Cloudinary file-upload network call (the `.dev.vars` held placeholder credentials) — consistent with this project's long-standing, repeatedly documented limitation that this sandbox can't reach real external payment/email/cloud-storage APIs (ganap.net, Resend, WorkOS have all hit the identical wall in prior rounds). The "Download Signed Copy" print view was checked by inspecting its generated HTML string directly (not a live browser print dialog, since headless Chromium in this sandbox doesn't exercise `window.print()`/"Save as PDF" meaningfully) — content, signature image, and signer/date/IP all render correctly in the generated markup.

### 23.8 Known open items

- **The schema migration in clienthub's `d1/schema.sql` (the 8 new tables) has not been run against the live database** — this session has no real Cloudflare/D1 access. Run it before relying on any of this in production; see clienthub's CLAUDE.md §24.
- **altaventureswebsite needs a brand-new D1 binding added in the Cloudflare Pages dashboard** (variable name `DB`, bound to the exact same shared database id this app and clienthub already use) — it has never had database access before this feature. See altaventureswebsite's CLAUDE.md §59 for the full detail.
- **Real Cloudinary file uploads from the public questionnaire form were not exercised live**, same standing sandbox limitation as every other external-API integration in this project's history.
- **ClientKeeper's admin shell (`Layout.tsx`) is not responsive at mobile widths**, affecting this feature's two new editor pages exactly as much as every other existing page in the app (§23.7) — not something to fix as part of this feature, but worth a dedicated pass if staff ever need to use ClientKeeper from a phone.
- Material-revision re-acceptance (publishing after signing resets status and requires a new signature) is the only "are you sure" gate in this flow; there's no separate confirmation dialog warning staff before they publish over a signed proposal — the amber note in the Signature card is informational, not a blocking confirm. Add one if the operator wants an extra guard rail there.

---

## 24. Client Detail page: core identity fields are now editable [2026-10-15]

Per the operator's direct request ("We should be able to edit everything even client's details"): the Identity card on the Client Detail page was plain read-only text (name, business name, email, mobile, Facebook, existing website) with no way to correct a typo or update a changed number after the client record was created. The only existing editable fields on this whole page were narrower, purpose-built ones (`set-dates.ts` for domain/renewal dates, `set-plan.ts` for the plan override, `set-project-website.ts` gated to post-presentation stage) — core identity had no edit path at all.

**New endpoint, `POST /api/app/clients/:id/set-details`**, following the exact same optional-field convention as `set-dates.ts`: every field (`fullName`, `businessName`, `email`, `mobile`, `facebook`, `currentWebsite`) is independently optional, so a one-field edit doesn't require resending everything. `fullName`/`businessName`/`email` reject an empty value (the `clients` table declares them `NOT NULL`); the other three accept an empty string to clear them. Email gets the same format check (`EMAIL_RE`) and case-insensitive duplicate check already used by the manual-add-client endpoint (`clients/index.ts`), excluding the client's own row, so an edit can never silently collide with another client's email. Writes `audit_log` (before/after snapshot) and `client_activity` (`set_client_details`), same pattern as every other sensitive write in this app.

**`ClientDetailPage.tsx`'s Identity card** gained an Edit/Save/Cancel toggle: "Edit Details" switches the card into a plain form (all six fields as inputs, including Client name and Business name, which previously only ever appeared in the page header, never as editable fields anywhere). Save calls the new endpoint and, only on success, closes the form and reloads the client (the header's name/business-name text updates automatically since it already reads from the same `client` object). **Deliberately not routed through this page's shared `run()` helper** — `run()` always closes out and reloads regardless of success or failure, which here would have closed the edit form and discarded the staff member's typed values the moment a duplicate-email 409 (or any other validation error) came back. Failure now shows the error banner with the form still open and every typed value intact; Cancel discards changes and returns to the read-only view without calling the server at all.

**How this was tested:** `npm run build`, `npx tsc -b`, `npx tsc -p functions/tsconfig.json --noEmit`, and `npm run lint` all passed clean. Verified live against a real local D1 instance (gitignored `wrangler.toml`/`.dev.vars`, deleted after): a partial update (mobile only) left every other field untouched; a full update changed all six fields correctly; a duplicate-email attempt (another seeded client's address) correctly 409'd and left the first client's data unchanged; an invalid email format and an empty required name both correctly 400'd with the right message; clearing an optional field via an empty string correctly nulled it; a no-op request body correctly 400'd with "Nothing to update."; an unauthenticated request correctly 401'd. Confirmed via a direct D1 query that `updated_at` bumped and exactly one `set_client_details` activity row was written per successful call (and none for the rejected ones). Ran a full rendered-browser (Playwright) pass on top of that: opened a client with several fields blank, entered Edit mode, filled every blank field, saved, and confirmed the header and every card field updated correctly with zero console errors; triggered the duplicate-email case through the real form and confirmed the error banner renders while the form stays open with the typed email still visible (not reverted or cleared); clicked Cancel and confirmed the record was left completely unchanged. All scratch tooling (`playwright-core`, the verification script, the local D1 instance and its gitignored wrangler config) removed afterward; confirmed via `git status`/`git diff package.json` that only `functions/api/app/clients/[id]/set-details.ts` (new), `src/lib/api.ts`, and `src/pages/ClientDetailPage.tsx` changed.

**Known open items:**
- Scoped to the Identity card's six fields only, per the literal complaint about those specific fields reading as plain text. Other record-level data on this page (stage, plan, dates, discovery/presentation notes) already has its own dedicated edit path from earlier rounds; this didn't touch any of that.
- No confirmation dialog before saving an identity edit (unlike, say, client deletion) — a plain Save is consistent with how every other edit control on this page already behaves (Set Plan, Save Dates), so this matches existing conventions rather than introducing a new one.

---

## 25. Proposal Generator: a proposal can now target a prospect, not just a client [2026-10-15]

Per the operator's direct follow-up request ("Can we make another Proposal generator that doesnt need a client to be generated?"), confirmed via a clarifying question before building (two options presented: a proposal that targets a lead instead of requiring a client, vs. a fully separate standalone tool with no DB link at all — the operator picked the former). This extends §23's Proposal Generator rather than building a second one, reusing the existing `leads` table (§2's "Leads: pre-payment records + statuses") as the prospect record a proposal attaches to, instead of inventing a parallel "prospect name" field directly on `proposals`.

### 25.1 Schema: `proposals.client_id` nullable, sibling `lead_id` added

See clienthub's CLAUDE.md §25 for the schema side. Exactly one of `client_id`/`lead_id` is expected on any proposal; enforced here in application code (the two creation endpoints each only ever set one), not a DB `CHECK`. A questionnaire can only ever be linked to a client-backed proposal — `questionnaires.client_id` stays `NOT NULL`, unchanged — so a lead-backed proposal's "send to questionnaire after signing" option is unavailable until it's attached to a real client.

### 25.2 Backend: detail/publish/revoke flattened to a single `/api/app/proposals/:id`, creation/listing stay parent-scoped

A proposal now resolves by its own id alone for anything that doesn't need to know which parent it has — `GET/PATCH /api/app/proposals/:proposalId`, `POST .../publish`, `POST .../revoke` replace the old `clients/:id/proposals/:proposalId...` nesting entirely (those three files deleted outright, not kept as dead code, since nothing could still reach them once the frontend route changed). Listing and creation, where "all of this parent's proposals" is a meaningful question, stay parent-scoped: `GET/POST /api/app/clients/:id/proposals` (unchanged) and the new sibling `GET/POST /api/app/leads/:id/proposals`.

The lead-scoped creation endpoint mirrors the client one closely (same `generateUniqueSlugAndToken` call, same `audit_log` write) but inserts with `lead_id` set and `client_id` left `NULL`, and skips the `client_activity` write entirely — leads have no equivalent activity timeline in this schema, and `functions/api/app/leads/[id].ts`'s own existing comment already notes leads have no structural link to clients. The global `audit_log` entry still records the action either way. `publish.ts`/`revoke.ts` now guard their own `client_activity` write with `if (proposal.client_id)`, so a lead-backed proposal's lifecycle writes no activity row anywhere but still produces a correct `audit_log` trail — verified directly (§25.4).

`GET /api/app/leads/:id` gained a handler (previously PATCH-only) so `LeadDetailPage` has something to load.

### 25.3 Frontend: `LeadDetailPage`, an "Add Lead" form, and the editor adapting to whichever parent it has

- **`src/pages/LeadDetailPage.tsx`** (new, `/leads/:id`) — a deliberately minimal page (contact fields, status/notes editor, a Proposals block) mirroring `ClientDetailPage`'s own `ProposalsBlock` pattern, without any of the projects/billing/discovery sections a lead doesn't have yet.
- **`LeadsPage.tsx` gained an "+ Add Lead" form** — a real, previously-missing gap, not a design choice being revisited: this page had no way to create a lead at all before this round (every existing row arrived via a payment webhook or a manual D1 insert), which would have left the new feature with nowhere to create a prospect to attach a proposal to. Kept small (name/business/email/phone, source always `"manual"`) since the richer editing already lives on the new detail page. The Name column is now a link into it.
- **`ProposalEditorPage.tsx`** moved to the flat route `/proposals/:proposalId` (no more `:clientId` segment) and now reads which parent it has from the detail response itself (`proposal.clientId`/`proposal.leadId`) to render the right "Back to client" vs. "Back to lead" link, and to replace the questionnaire-link card with a plain explanatory note when there's no client to link one to, rather than offering a control the server would reject.
- **`ClientDetailPage.tsx`'s existing `ProposalsBlock`** updated its two hardcoded `/clients/:clientId/proposals/:id` paths to the new flat `/proposals/:id` — this is the only change on the client side; `createProposal`/`fetchProposals` (still client-scoped) are untouched.

### 25.4 How this was tested

`npm run build`, `npm run lint`, and `npx tsc -p functions/tsconfig.json --noEmit` all passed clean. Verified live, end to end, against a real local D1 instance shared with altaventureswebsite (two `wrangler pages dev` processes, matching `database_name`/`database_id` in each repo's own temporary, gitignored `wrangler.toml`, both deleted after), using the same hand-built, correctly HMAC-signed `ck_session` cookie technique as §23.7:

- **Lead-backed path, full lifecycle:** created a lead via the new `POST /api/app/leads`, created a proposal for it (`client_id: NULL`, `lead_id` set, confirmed via the flat `GET /api/app/proposals/:id`), confirmed `PATCH .../questionnaireId` correctly 400s ("This proposal has no client yet..."), published it, and signed it via altaventureswebsite's real public `/api/public/proposal/:slug` + `/sign` endpoints — confirmed `proposals.status` ends at `'signed'`, a real `proposal_signatures` row exists, and (the actual point of this change) `client_activity` has **zero** rows anywhere, while `audit_log` correctly shows both `proposal_created` and `proposal_published`.
- **Client-backed path, regression check:** seeded a real client row directly, created/patched/published/revoked a proposal for it through the exact same (now-flattened) endpoints, and confirmed `clientId` comes back populated / `leadId` null, and that `client_activity` **does** get three rows (`proposal_created`, `proposal_published`, `proposal_revoked`) exactly as before — confirming the flattening didn't change client-backed behavior at all, just the URL shape.
- **A real rendered-browser pass** (Playwright, the same injected-cookie technique as §23.7): navigated to `/leads`, used the new "+ Add Lead" form to create a prospect, confirmed it correctly lands on the new `LeadDetailPage` showing the entered contact info; clicked "+ New Proposal", confirmed it lands on `/proposals/:id` showing "Back to lead" and the no-questionnaire explanatory note (not a broken/empty control); clicked "Back to lead" and confirmed the new proposal now appears in that lead's Proposals list. Zero console/page errors throughout. Screenshot-verified the lead detail page at 1280px and the proposal editor at 390px mobile — the only thing visible at mobile width is the same pre-existing, already-documented `Layout.tsx` non-responsive-sidebar characteristic noted in §23.7, not a new regression.

All scratch tooling (the two `wrangler pages dev` processes, their gitignored `wrangler.toml`/`.dev.vars`, the shared local D1 `--persist-to` directory, a temporary `playwright-core` install, verification scripts and screenshots) removed afterward; confirmed via `git status`/`git diff package.json` that only the intended files changed: the three deleted nested endpoint files, `functions/api/app/leads/[id].ts` (GET added), the two new `functions/api/app/proposals/` and `functions/api/app/leads/[id]/proposals/` directories, `src/lib/api.ts`, `src/App.tsx`, `src/pages/ClientDetailPage.tsx`, `src/pages/LeadsPage.tsx`, `src/pages/ProposalEditorPage.tsx`, and the new `src/pages/LeadDetailPage.tsx`.

### 25.5 Known open items

- Same standing gaps as §23.8 (the live D1 migration hasn't been run, altaventureswebsite's D1 binding still needs to be added in the Cloudflare Pages dashboard, real Cloudinary uploads untested, the admin shell isn't responsive at mobile widths) — none of those changed in this round.
- **No UI exists yet to convert a lead-backed proposal to a client-backed one** (e.g. once a prospect pays and becomes a real client, re-pointing their existing proposal at the new `clients` row instead of leaving it on the lead forever). Not built speculatively here since it wasn't asked for — a lead can already be marked `status: 'converted'` manually (unchanged, existing behavior), but that's bookkeeping only, per `leads/[id].ts`'s own comment ("no structural link to clients"); it does not touch any proposal's `client_id`/`lead_id`.

---

## 26. Proposal Generator: a fully standalone proposal (no lead, no client) now auto-creates a real client when signed [2026-10-16]

Per the operator's direct follow-up request ("We should be able to create a proposal even outside of a lead or client. Then when the client signs it then it creates a client profile"), confirmed via two clarifying questions before building:
1. **Where does the contact info a real client record needs come from, for a proposal with no lead and no client at all?** → Staff enter it directly when creating the proposal (not collected from the public signer — the public signing page itself is unchanged).
2. **Does this also apply to an already-lead-backed proposal (auto-converting a lead to a client on signature), or only to brand-new standalone proposals?** → Standalone proposals only; a lead-backed proposal's signing behavior is completely unchanged.

**New flat creation endpoint, `POST /api/app/proposals` (`functions/api/app/proposals/index.ts`), no parent in the URL at all.** The two existing creation endpoints (`/clients/:id/proposals`, `/leads/:id/proposals`) stay parent-scoped since "all of this client's/lead's proposals" is a meaningful list; this one has no parent, so it lives at the flat root. Requires `prospectFullName`, `prospectBusinessName`, and a valid `prospectEmail` (the exact three fields the shared `clients` table requires `NOT NULL`) — `prospectPhone` and `title` are optional, with `title` defaulting to `Proposal for {businessName}`. Inserts with `client_id = NULL, lead_id = NULL`, storing the four fields on the new `prospect_*` columns (clienthub CLAUDE.md §26).

**`GET /api/app/proposals/:proposalId` now also returns `prospectFullName`/`prospectBusinessName`/`prospectEmail`/`prospectPhone`** (read-only — no `PATCH` support for these columns, per the operator's own "entered once, at creation" decision) so the editor can show them.

**Entry point: a "+ New Proposal" button on the Leads page**, next to the existing "+ Add Lead" button, opening an inline form (`NewStandaloneProposalForm`, mirroring `AddLeadForm`'s existing shape) that collects the prospect's name/business name/email/phone and an optional title, then navigates straight to the new proposal's editor. The Leads page is already the natural home for this — it's already "the page for working with a prospect who isn't a client yet" (its own header comment on `AddLeadForm`, added in §25, says as much), and this is the second proposal-creation entry point to live there for exactly that reason.

**`ProposalEditorPage.tsx` updates for the standalone case:**
- The "back to..." link now has a third branch: a standalone proposal (no `clientId`, no `leadId`) shows "← Back to leads" instead of nothing.
- A new banner directly below it, visible only for a standalone proposal, states the stored prospect info (name, business, email, phone) and explicitly tells staff what happens next: "A real client record is created automatically from this info the moment the prospect signs."
- The existing "Send to Questionnaire After Signing" card's fallback copy (shown whenever there's no client yet) now branches on whether this is a lead-backed or standalone proposal, since the original single copy ("Convert this lead to a client first...") was wrong for a proposal that was never backed by a lead in the first place — caught during this round's own Playwright screenshot verification, not reported by the operator. Fixed to read "Once the prospect signs, a client is created automatically and you can link one then" for the standalone case.

**The public sign endpoint auto-creates the client, not this app.** All of the actual client-creation logic lives in altaventureswebsite's `functions/api/public/proposal/[slug]/sign.ts` (CLAUDE.md §63) — this repo's role here is purely the authoring side: collecting the prospect info, storing it, and displaying it back.

**How this was tested:** two separate `wrangler pages dev` processes (this repo and altaventureswebsite), both pointed at one shared local D1 instance via matching `database_name`/`database_id` in each repo's own temporary, gitignored `wrangler.toml` (deleted after the session, same cross-repo methodology as §23/§25). Backend, via curl against a minted session cookie (HMAC-signed locally with the same algorithm as `functions/_lib/session.ts`, matched against a seeded `users` row): confirmed `POST /api/app/proposals` succeeds with valid input, 400s on a missing/invalid email, and 401s with no session cookie at all; confirmed the created proposal's detail correctly returns the four `prospect_*` fields; drafted content, published, and — via altaventureswebsite's public sign endpoint — signed it, then confirmed directly against D1 that a new `clients` row was created from the stored prospect info and the proposal's `client_id` was updated to point at it. Confirmed the idempotent-by-email path: creating and signing a SECOND standalone proposal under the same (differently-cased) email linked to the SAME client rather than creating a duplicate, with the existing client's `mobile` preserved via `COALESCE` rather than overwritten. Confirmed a lead-backed proposal (created via the existing `/leads/:id/proposals` endpoint, published, then signed) leaves `client_id` NULL and the lead's own `status` untouched, exactly matching the operator's "standalone proposals only" scope decision.

---

## 27. Proposal Generator: a configurable "Payment Request" card in the editor, wired to the new `payment_*` columns [2026-10-29]

Per the operator's direct feature request ("We should be able to configure the payment method and amount in the proposal set up screen"), `ProposalEditorPage.tsx` gained a new "Payment Request" card controlling whether, and with what details, a client lands on a payment screen immediately after signing. See clienthub's CLAUDE.md §27 for the six new `payment_*` columns this reads/writes, and altaventureswebsite's CLAUDE.md §67 for the actual public-facing payment screen this configures.

**`GET`/`PATCH /api/app/proposals/:proposalId` extended with the six new fields.** `loadProposal()`'s `ProposalRow` interface and SELECT now pull `payment_enabled`, `payment_amount_label`, `payment_gcash_number`, `payment_gcash_account_name`, `payment_bank_note`, `payment_marked_paid_at`; the GET response exposes all six (camelCased, `paymentEnabled` as a real boolean). PATCH accepts the five settable fields (each falling back to the existing stored value if omitted from the request body, so a save that doesn't touch payment config never clobbers it) and writes them in the same `UPDATE proposals SET ...` statement that already handles title/content/questionnaire.

**These five fields are deliberately non-versioned — they take effect immediately, even on an already-published or already-signed proposal, with no republish and no fresh signature required.** Every other field this endpoint writes (title, content) is contractual and already requires the existing publish → fresh-signature cycle to change. Payment details are operational: a staff member fixing a wrong GCash number or correcting an amount typo shouldn't have to invalidate a client's existing signature to do it. `payment_marked_paid_at` itself is never writable through this endpoint at all (server-set only, by the public page's "Done Paying" click).

**`POST /api/app/proposals/:proposalId/publish` gained one new validation and one new side effect:**
- Blocks publishing with `{"error": "Set a payment amount before publishing, or turn off the payment request for this proposal."}` whenever `payment_enabled` is on and `payment_amount_label` is blank — the one payment field that has no sensible default and is always proposal-specific, so an empty amount reaching a real client would be a real bug, not an edge case worth silently allowing.
- Republishing a proposal that was already `signed` now also clears `payment_marked_paid_at` back to `NULL`, alongside the existing re-signature requirement — a stale "the client said they paid" claim against terms that just changed isn't meaningful, the same reasoning already governing why a content revision forces a fresh signature at all.

**The editor UI:** a new `<Card title="Payment Request">`, positioned after the existing Signature card and before "Send to Questionnaire After Signing" — directly below the two things that need to already be understood (what the client signed, when) and directly above the next thing in the sequence (where they go after signing). A single "Request payment after signing" checkbox gates everything else; when on, four inputs appear (Amount — placeholder `e.g. ₱25,000`, since there's no sensible real default — GCash Number, GCash Account Name, Bank Transfer Note), all pre-filled from the proposal's current stored values (which default to Altaventures' own real payment details on a brand-new proposal, per clienthub CLAUDE.md §27). A one-line note under the fields states plainly that changes save via the existing "Save Draft" button and take effect immediately, matching the non-versioned behavior above.

**A new banner inside the existing Signature card, shown only once `proposal.paymentMarkedPaidAt` is set:** "Client marked this as paid on {date}. This is the client's own claim, not a confirmed payment — verify against the actual GCash/bank transfer before treating the project as funded." Placed in the Signature card rather than the new Payment Request card since it's about verifying what already happened (alongside the existing signature record), not about configuring what happens next.

**How this was tested:** same cross-repo local-D1 methodology as §26 (two `wrangler pages dev` processes, one shared local D1 instance, a manually-minted `ck_session` cookie). Backend, via curl: created a standalone proposal, `PATCH`ed it with real content plus payment config, confirmed the `GET` reflects every field correctly; confirmed `publish` correctly 400s with the new error when `payment_enabled` is on (the default) and the amount is blank, and succeeds once filled in; confirmed a full sign → mark-paid round trip via altaventureswebsite's public endpoints correctly surfaces `paymentMarkedPaidAt` back on this repo's own `GET`; confirmed republishing an already-signed proposal clears both the signature and `paymentMarkedPaidAt` in one step. Screenshot-verified the editor UI directly (via Playwright, authenticated with the same minted cookie, no real WorkOS login): the Payment Request card renders with the checkbox checked and all four fields correctly pre-filled from the saved values, the "SIGNED" status badge, the full signature record, and the "Client marked this as paid..." banner all render correctly together on one page. `npm run build` passed clean. All scratch tooling (both repos' `wrangler.toml`/`.dev.vars`, the shared local D1 persist directory, the cookie-minting script, verification/screenshot scripts, both dev server processes) removed/stopped afterward; confirmed via `git status`/`git diff package.json` that only the intended files changed in both repos.

Also ran a full rendered-browser (Playwright) pass, not just the backend curl checks, since a curl-only pass wouldn't catch a frontend rendering/copy bug (this project's own established practice, per clientkeeper's own CLAUDE.md §23.6 rich-text-editor bug, which only a rendered pass caught): loaded `/leads` with a cookie set directly on the browser context, clicked "+ New Proposal," filled the form, submitted, and confirmed it landed on the new proposal's editor page showing the standalone banner with the correct prospect info and a working "← Back to leads" link (screenshot-verified). This same pass is what caught the stale "Convert this lead" copy bug on the questionnaire-link card, fixed and re-verified in the same round. Confirmed zero horizontal overflow at a 390px mobile viewport with the new form open. All scratch tooling (`playwright-core`, the verification scripts, the two `wrangler pages dev` processes, their gitignored `wrangler.toml`/`.dev.vars`, the shared local D1 `--persist-to` directory) removed afterward; confirmed via `git status`/`git diff package.json` that only the intended files changed: `functions/api/app/proposals/[proposalId].ts`, `src/lib/api.ts`, `src/pages/LeadsPage.tsx`, `src/pages/ProposalEditorPage.tsx` modified, and the new `functions/api/app/proposals/index.ts` added.

---

## 28. Full mobile-responsiveness pass: the sidebar shell, four recurring overflow bug classes, and a systematic crawl [2026-10-30]

Per the operator's direct request ("Make client keeper mobile responsive"), this round made the entire app usable on a phone. ClientKeeper had been built desktop-only throughout its history — every page assumed a fixed-width sidebar and enough horizontal room for dense flex/grid rows — so this was a full sweep, not a targeted fix.

### 28.1 The sidebar shell: a static layout rebuilt as an off-canvas drawer

`src/components/Layout.tsx`'s `<aside>` was a plain `flex` child with no responsive behavior at all — on a narrow viewport it simply squeezed the `<main>` content into whatever space was left, the single biggest blocker to the rest of the app being usable at all. Rebuilt around a standard off-canvas drawer pattern:
- A new `mobileNavOpen` state, `md:hidden`-only sticky top bar (logo + hamburger button) that only exists below the `md:` breakpoint.
- The `<aside>` itself: `fixed inset-y-0 left-0 z-50 w-72 -translate-x-full transition-transform duration-200 md:static md:translate-x-0`, toggled open via a conditional `translate-x-0` override — `md:` and up, it's pinned in place exactly as before (confirmed via screenshot: byte-identical desktop rendering).
- A `fixed inset-0 z-40 bg-black/40 md:hidden` backdrop, dismissible by tapping outside the drawer.
- Every nav link gained `onClick={closeMobileNav}` so tapping a destination both navigates and closes the drawer in one motion (verified: tapping "Clients" in the open drawer lands on `/clients` with the drawer already closed, no second tap needed).
- `<main>` gained `overflow-x-hidden` as a defense-in-depth backstop against any future overflow bug reaching the page edge, plus mobile-first padding (`px-4 py-6 sm:px-6 md:px-8 md:py-8`, was a flat `px-8 py-8`).

**This one CSS property turned out to be a double-edged sword for testing, not the app.** `overflow-x-hidden` on `<main>` is good production defense (it stops a future bug from ever producing a page-level horizontal scrollbar), but it also means `document.documentElement.scrollWidth` — the obvious, cheap way to check "does this page overflow?" — stops being a reliable signal, since an ancestor's `overflow-x: hidden` clips a descendant's real overflow from ever propagating up to the document level. A scrollWidth-based crawl against a build with this property already in place would report every page "clean" even when real content is being cut off and visually unreadable. This is why the verification methodology below checks real element geometry directly rather than trusting `scrollWidth`.

### 28.2 Four recurring overflow bug classes, found by a systematic crawl, not a visual skim

Building a trustworthy crawl took two wrong turns before landing on the right check, worth recording since the gotcha will recur the next time this codebase needs a similar sweep:
- **Naive per-element `getBoundingClientRect().right > viewportWidth`** flags every `<table>`/`<thead>`/`<tr>`/`<th>` inside the many `overflow-x-auto` table wrappers already used throughout this app (Dashboard, Leads, Clients, Projects, Discovery, Presentations, Offers, Billing, Payments, MyCafe all have real data tables). That's false-positive noise, not a bug — those tables are *supposed* to be wider than their container and scroll internally.
- **The correct check**: flag an element only if its own right edge exceeds the viewport **and** no ancestor up to `<body>` has `computed overflowX === "auto" || "scroll"` — that ancestor already contains the overflow on purpose. This distinguishes "legitimately wider than the viewport, scrolls within itself" from "genuinely breaks the page."
- **A stale test session cookie produced a false "all clean" result mid-sweep.** The hand-minted `ck_session` cookie used for local testing (see §23's own established cross-repo methodology) carries an `issuedAt` timestamp baked in at mint time; once enough wall-clock time passed during this long session, the server-side session check correctly treated it as expired and the app's own WorkOS redirect fired — landing every test page on a short, genuinely non-overflowing SSO error page instead of real app content, which trivially "passed" the overflow crawl without testing anything real. Caught by noticing a page the crawl called "clean" didn't match a targeted follow-up check; fixed by re-minting a fresh cookie and re-running the entire crawl, which immediately surfaced the real bug the stale-session run had silently hidden. Worth remembering for next time: a clean crawl result is only as trustworthy as the session it ran under — spot-check at least one page's real content, not just its overflow status, if a long gap passes mid-sweep.

With a correct check and a fresh session, the crawl found the same underlying bug class recurring **four separate times**, all traceable to one CSS default: a flex or grid item's `min-width` defaults to `auto`, which lets its content's own intrinsic/preferred size win over an explicit `width: 100%`/`flex-1`, forcing the item (and the whole row/track it sits in) wider than its container. This project's own history (see `altaventureswebsite`'s CLAUDE.md, the `FybHero.tsx` `min-w-0` fixes) has hit this exact class before; it showed up here in four different shapes:

1. **A text `<input>` next to a `shrink-0` status badge**, in both `ProposalEditorPage.tsx`'s and `QuestionnaireEditorPage.tsx`'s title row — `className="w-full ..."` on the input, no `min-w-0`. Fixed by changing both to `min-w-0 flex-1`. Verified via direct `getBoundingClientRect()` measurement (not just a screenshot — a native `<input>`'s text-overflow clipping looks visually identical whether the underlying flex-sizing bug is present or not): input right edge 295.94px, badge left edge 307.94px, a clean 12px gap post-fix.

2. **A `Card` wrapper component, duplicated verbatim across six different page files** (`BillDetailPage.tsx`, `ClientDetailPage.tsx`, `LeadDetailPage.tsx`, `MyCafeClientDetailPage.tsx`, `ProposalEditorPage.tsx`, `QuestionnaireEditorPage.tsx` — each defines its own identical local `function Card({ title, children })`, not a shared import), missing `min-w-0` on its own root `<div>`. On `QuestionnaireEditorPage.tsx` specifically, this card sits inside a single-column CSS grid (`<div className="mt-4 grid gap-4">`) alongside a `<textarea className="w-full ...">` — a `<textarea>`'s browser-intrinsic sizing (driven by its default `cols` attribute) isn't fully overridden by `width: 100%` for a grid item's min-content calculation, so the Card was measured forcing itself to 395.67px wide against a 343px grid track, a real, visible 52px overflow confirmed via a full ancestor-chain `getBoundingClientRect()`/computed-style walk, not just inferred. `ClientDetailPage.tsx` has the identical `grid grid-cols-1 gap-5 lg:grid-cols-2` structure wrapping its own Cards, with two of its own `<textarea>`s (an admin-override reason field and an activity-notes field) at equal risk. Fixed by adding `min-w-0` to all six `Card` definitions — the four without a currently-reproduced bug (`BillDetailPage`, `LeadDetailPage`, `MyCafeClientDetailPage`, `ProposalEditorPage`) got the same defensive fix on the reasoning that `min-w-0` has zero effect on a block element outside a flex/grid context, so there's no downside, and this exact template has now caused two independently-reproduced bugs from six copy-pasted instances of itself.

3. **A `<select>` sharing a flex row with an un-`shrink-0`'d button** — `ClientDetailPage.tsx`'s "Plan" override control (`<select className="flex-1 ...">` listing plan names up to 38 characters long, e.g. "Partnership Arrangement (no fixed price)", next to a bare "Set Plan" button). This was the one bug the crawl caught live and unambiguous: a 47px overflow at exactly 320px (not 375/390 — the row only breaks at the very narrowest common phone width), `<button class="rounded-full border border-brand-blue ...">right=367 (+47px) text="Set Plan"`. Fixed with `min-w-0 flex-1` on the `<select>` and `shrink-0` on the button.

4. **Four more `<input>`+button flex rows in the same file, and one in `MyCafeClientDetailPage.tsx`**, sharing the identical shape as bug #3 but with `<input>` instead of `<select>` (a website-link field, a meeting-link field, a reschedule date field, two activity-note fields). None of these were caught actively overflowing by the crawl — a bare text `<input>`'s default intrinsic width is narrower than a `<select>`'s content-driven one, and the paired button labels here are short ("Save", "Save Link", "Reschedule") — but given the identical structural shape to the one bug that did reproduce, in the same file, these were hardened with the same `min-w-0 flex-1`/`shrink-0` pairing rather than left as a latent risk waiting for a longer placeholder or locale-dependent date format to tip them over.

### 28.3 Smaller, directly-confirmed overflow fixes

- **Four fixed-width (`w-72`, 288px) search inputs** — `ClientsPage.tsx`, `LeadsPage.tsx`, `MyCafePage.tsx` — changed to `w-full sm:w-72`, so they fill the available width on mobile instead of guaranteeing overflow below 288px.
- Every `<table>` across all 10 list pages was audited and confirmed already correctly wrapped in `overflow-x-auto` — no changes needed there, this was already right.
- `Modal.tsx` (the shared modal shell used by `AddClientModal`/`AddMyCafeClientModal`) needed no changes — already responsive.

### 28.4 How this was tested

Reused this project's own established cross-repo local-D1 methodology (`wrangler pages dev dist --persist-to=<shared path> --local`, matching `[[d1_databases]]` blocks across `clienthub`/`clientkeeper`, a hand-minted HMAC-signed `ck_session` cookie standing in for a real WorkOS login) with Playwright (`playwright-core` against the sandbox's pre-installed Chromium).

Built the correct ancestor-aware overflow check described in §28.2 and ran it across all 15 real routes (dashboard, leads, clients, client-detail, questionnaire-editor, projects, discovery, presentations, offers, billing, new-bill, payments, mycafe, settings, proposal-editor) at three narrow widths (320/375/390px) — confirmed **zero genuine overflowing elements anywhere** after all fixes, re-run with a freshly-minted session cookie to rule out the stale-session false-clean result described above. Went further than a route-by-route crawl alone, since several of the real bugs found live behind an interaction, not on initial page load:
- Expanded the collapsed "Admin override…" textarea on `ClientDetailPage` and re-ran the overflow check — clean at 320/375px.
- Opened both `AddClientModal` and `AddMyCafeClientModal` and re-ran the check — clean at 320/375/390px.
- Toggled `ClientDetailPage`'s "Edit Details" identity form open and loaded the proposal editor's rich-text toolbar — both clean at 320/375/390px.
- Screenshot-verified the drawer itself: closed state, open state (backdrop + slide-in correct), and that tapping a nav link both navigates and auto-closes the drawer in one interaction.
- Screenshot-verified both of the two actively-reproduced bugs' fixed states directly: the questionnaire-editor's Description textarea and title row render cleanly within a 375px viewport with no clipped content; the client-detail Plan card's select+button row fits without overflow.
- Screenshot-confirmed desktop (1440px) is visually unaffected: the sidebar still renders static and pinned, not as a hidden drawer, and the questionnaire-editor/client-detail layouts are unchanged from their pre-this-round appearance.

`npm run build`, `npm run lint` (`oxlint`), and `npx tsc -p functions/tsconfig.json --noEmit` all passed clean. All scratch tooling (both repos' `wrangler.toml`/`.dev.vars`, the shared local D1 persist directory, the cookie-minting script, ~12 verification/screenshot scripts, both `wrangler pages dev` processes) removed/stopped afterward; confirmed via `git status`/`git diff package.json` that only the ten intended source files changed, no dependency changes.

### 28.5 Known open items

- This was a structural/CSS-sizing sweep, not a design pass — the mobile layout now fits the viewport everywhere, but no page's visual density or touch-target sizing was deliberately re-tuned for a phone beyond what the overflow fixes themselves required. Revisit if the operator wants a dedicated mobile UX polish pass on top of this correctness pass.
- The `Card` component's six-times-duplicated definition (§28.2, bug class 2) was hardened in place everywhere it's used, but it remains six separate copies of the same ~8-line component rather than one shared import — consolidating it was judged out of scope for a responsiveness fix (a refactor risk with no responsiveness benefit beyond what the six individual `min-w-0` additions already provide), but it's worth doing the next time any of these six files gets touched for an unrelated reason, so this exact bug class can't recur a fifth time from the same copy-pasted source.

---

## 29. Service Agreement Generator: a direct clone of the Proposal Generator [2026-10-30]

Per the operator's direct request ("Can you like clone the proposal generator and create a service agreement generator?"), confirmed via two clarifying questions before building (relationship to the existing `/WSA-free`/`/WSA-pro` fixed-document pages; whether to carry the Proposal Generator's payment-request step): a new, parallel e-signature system for staff-authored, binding service agreements, mirroring the Proposal Generator's own architecture (§23 onward) component-for-component. The operator's two confirmed decisions: this is a genuinely new, separate capability, and it's signature-only — no payment step. See clienthub's CLAUDE.md §28 for the new schema and altaventureswebsite's CLAUDE.md §72 for the public-page side.

### 29.1 Backend: a file-for-file clone of the proposal endpoints, pointed at `service_agreements`

`functions/api/app/service-agreements/index.ts` (standalone list+create), `[agreementId].ts` (GET/PATCH), `[agreementId]/publish.ts`, `[agreementId]/revoke.ts`, plus the parent-scoped siblings `functions/api/app/clients/[id]/service-agreements/index.ts` and `functions/api/app/leads/[id]/service-agreements/index.ts` — same shapes, same validation, same audit-log/`client_activity` writes as their `proposals` counterparts, minus every payment_*-field reference and the `questionnaire_id` link/validation `publish.ts`'s proposal sibling carries. `functions/_lib/publicDocs.ts`'s `generateUniqueSlugAndToken()` had its `table` parameter's union type widened from `"proposals" | "questionnaires"` to include `"service_agreements"` — the one shared piece of infrastructure this clone actually needed to touch, rather than duplicate.

### 29.2 Frontend: `ServiceAgreementEditorPage.tsx`, minus two cards

A direct clone of `ProposalEditorPage.tsx`, same Public Link / Signature / Content / Version History card layout, same standalone-prospect banner, same "Download Signed Copy" print-to-PDF fallback. Two cards deliberately absent, both the operator's own confirmed decisions: **no "Payment Request" card** (no `paymentEnabled`/GCash/bank fields anywhere in this editor), and **no "Send to Questionnaire After Signing" card** (an intake-questionnaire concept that belongs to the sales proposal that precedes a contract, not the contract itself). Routed at `/service-agreements/:agreementId`, same flat-URL shape as `/proposals/:proposalId` (CLAUDE.md §25's own reasoning for why a document that can belong to a client, a lead, or neither doesn't carry a single parent id in its path).

### 29.3 Listing entry points: Leads page, Client detail, Lead detail — all three, same pattern as proposals

- **`LeadsPage.tsx`**: a `NewStandaloneServiceAgreementForm` (identical shape to `NewStandaloneProposalForm`, same "no lead or client needed" copy, same optional-email handling) sits next to the existing "+ New Proposal" button, and a second "Standalone Service Agreements" table section — its own independent search/status filter pair, same reasoning as the proposals section's own independent pair (the two status vocabularies happen to be identical here, but kept separate since a future change to either shouldn't silently affect the other) — lists every agreement with no client and no lead, same handoff-on-signing behavior.
- **`ClientDetailPage.tsx`** / **`LeadDetailPage.tsx`**: both gained a `ServiceAgreementsBlock` (clone of `ProposalsBlock`) in a new "Service Agreements" card, sitting directly after the existing "Proposals" card on each page. Both reuse the existing `PROPOSAL_STATUS_STYLES` constant rather than duplicating an identical status-color map — `ServiceAgreementStatus` and `ProposalStatus` are two separately-declared type aliases with an identical string-literal union, so TypeScript's structural typing accepts the reuse with zero type errors (confirmed by the build; this was the one place a first build attempt caught a real issue, an unused leftover import of the now-unneeded `ServiceAgreementStatus` type in `LeadsPage.tsx`, fixed immediately).

### 29.4 How this was tested

Reused this project's own established cross-repo local-D1 methodology (two `wrangler pages dev` processes, one shared local D1 instance via matching `wrangler.toml` `[[d1_databases]]` blocks, a hand-minted HMAC-signed `ck_session` cookie standing in for a real WorkOS login) — see altaventureswebsite's CLAUDE.md §72 for the shared half of this test writeup (the public-page/API verification); this section covers the ClientKeeper-specific half.

**Backend, via curl:** created a standalone agreement, confirmed `GET`/`PATCH`/`publish`/`revoke` all behave identically to their proposal counterparts (blank-content publish correctly 400s, a second revoke correctly 409s); created both a client-nested and a lead-nested agreement via their own endpoints and confirmed both list correctly under their respective parents.

**Frontend, via a full Playwright pass:** loaded `/leads` and confirmed both the "Standalone Service Agreements" heading and the "+ New Service Agreement" button render; used the real on-page form to create a new standalone agreement (not a direct API call), confirmed it navigated to the new agreement's editor showing the correct standalone banner with the prospect's info, confirmed the editor has neither a "Payment Request" nor a "Send to Questionnaire" card; typed real content into the rich-text editor and published, confirmed the status badge and the Public Link card both render correctly with a real, correctly-formed `/agreement/:slug?t=:token` URL. Separately confirmed via `/clients/:id` and `/leads/:id`: the "Service Agreements" card renders in both, lists the earlier-created client-/lead-nested agreements correctly, and clicking "+ New Service Agreement" from the client page correctly navigates to a new agreement's editor showing "← Back to client" (not the standalone banner, since this one has a real client parent). Two initial false-negative readings in the test script itself — a case-sensitive substring check against `document.body.innerText`, which reflects the Card titles' own CSS `uppercase` text-transform — were caught, confirmed via screenshot as test artifacts rather than real bugs (the identical, previously-documented pitfall this project's own `altaventureswebsite` CLAUDE.md history has hit and ruled out before, e.g. §31.5/§32/§35/§57 there), and resolved by re-checking case-insensitively.

Confirmed zero horizontal overflow and zero console/page errors at both 1280px desktop and 390px mobile throughout, including on the Client Detail page (the exact page whose mobile layout was just hardened in §28, confirming the new Service Agreements card doesn't reopen that work). `npm run build`, `npm run lint` (oxlint), and `npx tsc -p functions/tsconfig.json --noEmit` all passed clean. All scratch tooling (both repos' `wrangler.toml`/`.dev.vars`, the shared local D1 persist directory, the cookie-minting script, ~6 verification/screenshot scripts, both `wrangler pages dev` processes) removed/stopped afterward; confirmed via `git status`/`git diff package.json` that only the intended files changed, no dependency changes.

### 29.5 Known open items

- The new `service_agreements` tables still need their one-time production D1 deploy (clienthub's CLAUDE.md §28) before any of this works live.
- No bulk/CSV export, no agreement templates, and no "duplicate this agreement" shortcut exist — each one is authored from a blank draft, same as a proposal. Revisit if that becomes real friction.
- Same as the Proposal Generator before it, there's no reminder/follow-up mechanism for an agreement sitting unsigned — purely a manual "staff shares the link, staff checks back" workflow for now.

---

## 30. Service Agreement Generator corrected: client-only, no lead or standalone path [2026-10-31]

Per the operator's direct correction ("Service agreements are actually and must be linked to specific CLIENTS"), §29's first version was wrong to copy the Proposal Generator's lead/standalone flexibility onto a binding legal contract. A service agreement is signed with someone who is already a real, onboarded client — never a bare lead, never a prospect with no client record at all. See clienthub's CLAUDE.md §29 for the schema correction (`client_id` now `NOT NULL`, `lead_id`/`prospect_*` columns removed entirely).

**Deleted outright, not deprecated:** `functions/api/app/service-agreements/index.ts` (the standalone root list+create endpoint) and `functions/api/app/leads/[id]/service-agreements/index.ts` (the lead-nested endpoint). The only remaining creation path is `functions/api/app/clients/[id]/service-agreements/index.ts`, which needed no changes at all — it already only ever created a client-scoped agreement.

**`[agreementId].ts`, `publish.ts`, `revoke.ts` simplified** — `client_id` is now unconditionally present (per the corrected schema), so every `if (agreement.client_id)` guard around a `client_activity` write became an unconditional write, and the GET response dropped `leadId`/`prospectFullName`/`prospectBusinessName`/`prospectEmail`/`prospectPhone` entirely.

**`ServiceAgreementEditorPage.tsx`** lost its three-way "Back to client / Back to lead / Back to leads" branch and the standalone-prospect banner — it's now unconditionally "← Back to client," since that's the only case that can ever exist.

**`LeadsPage.tsx` and `LeadDetailPage.tsx`** had every trace of the service agreement feature removed — the `NewStandaloneServiceAgreementForm` component, its state/loader/listing section on the Leads page, and the "Service Agreements" card/`ServiceAgreementsBlock` on the Lead Detail page. Both files are now back to exactly their pre-§29 shape plus nothing; the Proposal Generator's own identical lead/standalone capability is completely untouched by this correction, since proposals genuinely are meant to reach a prospect before they're a client.

**`src/lib/api.ts`** dropped `fetchLeadServiceAgreements`, `createLeadServiceAgreement`, `fetchStandaloneServiceAgreements`, `createStandaloneServiceAgreement`, and the `StandaloneServiceAgreementRow` type entirely; `ServiceAgreementDetail.clientId` changed from `string | null` to `string`, and its `leadId`/`prospectFullName`/`prospectBusinessName`/`prospectEmail`/`prospectPhone` fields were removed.

**How this was tested:** reused this project's own established cross-repo local-D1 methodology against a freshly re-applied schema (the corrected `CREATE TABLE`, not a migration — see clienthub's CLAUDE.md §29). Confirmed via curl that the deleted standalone-root and lead-nested routes now correctly fall through to the SPA's `index.html` (confirmed by inspecting the response's `Content-Type: text/html`, not a real JSON 404 from a Function that no longer exists at that path — the expected Cloudflare Pages behavior for a removed route under a client-routed app). Confirmed the client-nested create/GET/PATCH/publish lifecycle still works exactly as before, and — the actual point of this round — confirmed via a direct D1 query that signing a client-linked agreement no longer touches the `clients` table at all (row count unchanged before and after signing), where the pre-correction version would have (harmlessly, since `client_id` was already set, but the dead code path existed). Confirmed all three `client_activity` entries (`created`/`published`/`signed`) still write correctly. Full Playwright UI pass: the Leads page shows neither a "+ New Service Agreement" button nor a "Standalone Service Agreements" section; the Client Detail page's existing "Service Agreements" card still lists and creates agreements correctly, and clicking into a signed agreement shows the plain "← Back to client" link with the real signature, no standalone/lead banner anywhere. `npm run build`, `npm run lint` (oxlint), and `npx tsc -p functions/tsconfig.json --noEmit` all passed clean. All scratch tooling (both repos' `wrangler.toml`/`.dev.vars`, a fresh shared local D1 persist directory, the cookie-minting script, ~3 verification/screenshot scripts, both `wrangler pages dev` processes) removed/stopped afterward; confirmed via `git status`/`git diff package.json` that only the intended files changed, no dependency changes.

---

## 31. MyCafe POS gets its own workspace, and an announcement manager ("What's New") [2026-11-18]

The operator asked for (a) an announcement/update manager here whose posts show up in every MyCafe café's Owner Panel under a **What's New** tab, and (b) MyCafe to have a separate UI in ClientKeeper, mobile responsive.

**Separate workspace.** MyCafe is no longer one page inside the web-development CRM's sidebar. `/mycafe/*` is its own route tree under `src/components/MyCafeLayout.tsx` (own header, own navigation, own brown accent — `mycafe`, `mycafe-dark`, `mycafe-soft` in `tailwind.config.js`), with a "← ClientKeeper" link back. The main nav still has one "MyCafe POS" entry that enters it. Mobile first: a compact header and a horizontally scrollable tab row on phones, a left rail from `md:` up; list pages render cards on phones and a table from `md:` up (`MyCafePage.tsx`); forms use stacked fields and full-width buttons below `sm:`. Routes: `/mycafe` (Overview — the live counts that used to sit on top of the café list, plus recent activity), `/mycafe/cafes` (the café list), `/mycafe/cafes/:id` (café detail; the old `/mycafe/:id` URL redirects), `/mycafe/announcements`, `/mycafe/announcements/new`, `/mycafe/announcements/:id`.

**Announcements.** Stored in MyCafe's own database (its migration 0033, applied), not in this app's D1; this app writes them through MyCafe's admin API (`/admin/announcements`, same `MYCAFE_ADMIN_API_TOKEN`/`MYCAFE_CONTROL_PLANE_URL` as everything else — no new secrets). `functions/_lib/mycafe.ts` has the thin pass-through (`list/get/create/update/deleteMyCafeAnnouncement`); `functions/_lib/mycafeAnnouncements.ts` has the shared route helpers (field whitelist, owner/admin gate, error mapping, audit row). Routes: `GET/POST /api/app/mycafe/announcements`, `GET/PATCH/DELETE /api/app/mycafe/announcements/:id`, all under the existing `/api/app/*` session + role middleware.
- **Who:** any staff role can read the list; create / edit / publish / unpublish / archive / delete are owner/admin only (a post reaches every café). Every write is audited (`audit_log`, `entity_type = 'mycafe_announcement'`, actions `…_created/_published/_unpublished/_archived/_updated/_deleted`). `author` is always the signed-in staff member, never taken from the request body.
- **Lifecycle:** draft → published → archived (and back). The first publish stamps the date and re-publishing keeps it. Only a never-published draft can be deleted — MyCafe refuses anything else (409); archive instead. Each post shows how many cafés have read it.
- **Content:** title ≤ 120, plain-text message ≤ 5000, a category (new feature / improvement / fix / announcement / maintenance), optional pin, one optional https link with button text. Text is shown escaped everywhere (preview here, Owner Panel there), never as HTML; MyCafe's database also rejects non-https links. The editor has a live "as café owners will see it" preview (`AnnouncementPreview.tsx`, mirrors the Owner Panel card).

**How it was tested.** `npx tsc -b`, `npx tsc -p functions/tsconfig.json --noEmit`, `npm run lint` and `npm run build` clean. Driven in a real browser (Playwright, API mocked) at 390 px and 1280 px: no horizontal overflow on any MyCafe page, create → publish → unpublish → delete flow, an `http://` link blocks Publish with a message, a published post offers no Delete, the legacy `/mycafe/<id>` URL redirects. **Not exercised live** against the deployed MyCafe control plane from this session (no deployment access from here) — the MyCafe side of the same API has its own 13 automated tests in `mycafe-pos-system`'s `cafe-api/test/announcements.test.ts`.

### 31b. Per-café sales, usage and billing, and account actions [2026-11-18]

The café detail page (`/mycafe/cafes/:id`, `MyCafeClientDetailPage.tsx`) gained three cards for a provisioned café, all live from MyCafe's admin API (nothing cached or stored here):
- **Sales** (`MyCafeSalesCard.tsx`, any staff role): 7/30/90 days of aggregates — net sales, orders, average order, refunds, a bar per day, how it was paid, top 5 products. Aggregates only; nothing identifies a customer, staff member or order. Days are Manila days, matching the café's own reports. Route: `GET /api/app/mycafe/clients/:id/sales?from=&to=`.
- **Usage & billing** (`MyCafeUsageCard.tsx`, any staff role): last order, last device use, orders in 7/30 days, staff and open shifts, billing history (no raw payment payloads), and the account-action log. Route: `GET .../:id/usage`.
- **Account actions** (`MyCafeAccountActionsCard.tsx`, owner/admin only): **Suspend** (reason required, shown to the café), **Reactivate**, **Extend trial** (7/14/30/60 days). Routes: `POST .../:id/suspend | reactivate | extend-trial`, each gated by `isMyCafeAdmin`, each audited in `audit_log` and `client_activity` here and in MyCafe's own append-only `admin_actions` ledger. A suspended café's POS and Owner Panel show an "account suspended" screen at once; nothing is deleted and devices stay paired, so Reactivate restores service immediately.
Shared route helpers: `functions/_lib/mycafeClientRoute.ts`. MyCafe-side rules (suspend only from active, reactivate only from suspended, trial extension refused on a paid plan) return 409 and are shown as the error message.

**Push events are deliberately not built.** This app has no public endpoint by design (§0, §6.1); MyCafe would have to call in. Everything is read live instead.

**Layout lesson (add to §28's list):** a CSS grid with no explicit template (`grid gap-5 sm:grid-cols-2`) sizes its single column to the widest *min-content* of its children, so one long unbreakable string (a product name, a payment reference) made every card on the page ~490 px wide on a 390 px phone — and `scrollWidth > innerWidth` did not catch it, because a mobile browser widens the layout viewport instead. Always write `grid-cols-1` as the base (it is `minmax(0, 1fr)`), give grid children `min-w-0`, and test mobile pages by asserting `window.innerWidth` still equals the device width, not only that nothing scrolls.

**Tested:** `tsc -b`, functions typecheck, lint, build clean. In a browser (API mocked) at 390 px and 1280 px as owner and as a sales-role user: the account-actions card is hidden for sales; extend trial, suspend (button disabled without a reason), reactivate all work and keep their success notices; layout width is exactly the device width on every MyCafe page. **Not exercised against the live MyCafe control plane.**

### 31c. "All cafés": every MyCafe café and its sales, not only ClientKeeper's own clients [2026-11-19]

The operator could not see "all the users and their sales". Cause: `/mycafe/cafes` listed only `clients` rows created here (`product = 'mycafe_pos'`), so cafés that signed up on their own — which the Overview counts already included, since those come from MyCafe's control plane — were missing, and sales were only visible one café at a time.

- **Cafés → "All cafés"** (default tab, `MyCafeAllCafes.tsx`; the old list is the second tab "Clients & provisioning", kept at `?view=clients`): every café from MyCafe's own list with plan state (Paid tier / Trial · Nd left / Expired / Suspended / Setting up), sales and order count for 7/30/90 Manila days, last order, devices, plus an all-cafés total. Search (café, store, owner, email), filter by state, sort by sales / latest order / name / newest. Cards on phones, a table from `md:`.
- Route: `GET /api/app/mycafe/cafes?days=` (any staff role) merges MyCafe's `/admin/cafes` and `/admin/sales-overview` with the local `clients.mycafe_cafe_id` link, so each row knows its ClientKeeper client (or `null`). Live, nothing stored; sales are aggregates only.
- **A café with no client record** shows "Add to ClientKeeper" (owner/admin): `POST /api/app/mycafe/cafes/:cafeId/adopt` creates the client from the café's own record (owner, business, store, slug), links it and opens its detail page; audited. If a client with the owner's email already exists it is not overwritten: 409 with that client's id. Other roles see "Not a client yet".
- `MyCafeLayout` is now `max-w-7xl` so the table fits without a horizontal scroll at 1280 px.

---

## 32. Webmail module: staff mailboxes inside ClientKeeper (`/mail`) [2026-11-24]

A full business webmail client for Altaventures staff, built from the operator's "Standard Webmail Module V1.0" spec: folders, conversation threading, search, labels, bulk actions, attachments, signatures, several sender identities, a composer with autosave, SMTP sending with tracked retries, and inbound mail through Cloudflare Email Routing. It covers desktop (three panes) and mobile. Every action reads and writes D1 through real API routes. No part of it is a UI-only mockup.

**Decisions confirmed with the operator before building (not re-asked):**
1. **Altaventures staff mailboxes only**, not per-client mail, so there is no `tenant_id`. The mailbox identity (`mail_accounts`) is the scoping unit. Which addresses exist is data, not code; hello@/support@/sales@/billing@ are only suggestions in the schema comment.
2. **Access is explicit and defaults to nobody.** `mail_account_access` (account, user, can_send) is granted by owner/admin from Mail settings → Mailboxes & access. Owner/admin can manage access but have **no implicit read access** to any mailbox; they grant it to themselves like anyone else. `can_send = 0` gives read-only access, and the identity then never appears in that person's From picker.
3. **Inbound uses Cloudflare Email Routing plus a dedicated Email Worker.** The altasme.com MX records move off Purelymail/Titan (legacy) to Email Routing. That DNS work is done outside this session.
4. **Outbound uses literal SMTP, not Resend.** The existing Resend helper (`functions/_lib/email.ts`) and its three callers are untouched.

### 32.1 Architecture

- **A new deployable unit, `mail-worker/`, is a standalone Cloudflare Worker, not part of the Pages project.** Email Routing can only deliver to a Worker's `email()` handler, and Pages Functions have no cron. The Worker therefore does two jobs: `email()` (inbound → D1/R2) and `scheduled()`, every minute (outbound retries, reaping sends stuck mid-flight, purging Trash after 30 days). It has its own `package.json` (one dependency, `postal-mime`), `tsconfig.json` and a **committed** `wrangler.toml`. The root `.gitignore` ignores `wrangler.toml` everywhere, so a `!mail-worker/wrangler.toml` negation was added; this one holds no secrets. The Worker imports the same `functions/_lib/mail/*` modules as the Pages routes through relative paths (wrangler's esbuild bundles them), so both writers produce identical rows.
- **Shared library `functions/_lib/mail/`:** `address` (parsing/validation/RFC 2047, plus header-injection rejection), `threading` (Message-ID/In-Reply-To/References, Reply/Reply-All recipient rules), `mime` (MIME builder), `smtp` (protocol client, injected socket) + `smtpTransport` (the real `cloudflare:sockets` connector), `sanitize` (inbound HTML), `store` (message/thread persistence + FTS indexing + permanent delete), `send` (queue → attempt → retry pipeline + cron entry point), `sendRoute`, `query` (list/search), `detail`, `actions` (single + bulk mailbox actions), `compose` (reply/forward prefill + signatures), `drafts`, `storage` (R2 keys, filename/MIME validation), `access`, `config` (env, SMTP resolution, policy, user settings), `events`, `route`, `http`.
- **Routes under `functions/api/app/mail/`**, all behind the existing `_middleware.ts` session+role gate, then a per-mailbox access check through `mailHandler()`. A message, thread, draft, label or attachment in a mailbox you can't access returns **404, never 403**, so ids can't be probed. Endpoints: `identities` (GET, POST admin), `identities/:id` (PATCH admin), `identities/:id/access` (GET/PUT admin), `identities/:id/signatures`, `signatures/:id`, `staff` (admin), `counts`, `messages` (list), `messages/bulk`, `messages/:id` (GET/PATCH/DELETE), `messages/:id/{archive,junk,restore,inbox,star,labels,raw}`, `messages/:id/labels/:labelId`, `threads/:id`, `search`, `send`, `reply`, `reply-all`, `forward`, `send/retry`, `drafts` (+ `:id`, `:id/send`), `labels` (+ `:id`), `attachments/upload`, `attachments/:id` (download/DELETE), `attachments/:id/preview`, `settings`.
- **Storage:** attachment bytes and raw `.eml` copies go in a **private R2 bucket** (binding `MAIL_ATTACHMENTS`, bound to both this Pages project and the Worker). I did not reuse the ecosystem's existing file pattern, the marketing site's Cloudinary questionnaire uploads, because Cloudinary returns permanent public URLs, which the spec explicitly forbids for mail. No attachment ever has a public URL: every byte is served through an authenticated, access-checked route. I chose "authenticated access" from the spec's two options rather than signed URLs, so no unauthenticated endpoint was added and §0's "zero public endpoints" still holds.
- **Frontend:** `/mail` is its own full-screen workspace (`src/pages/MailPage.tsx`), outside `Layout`, like MyCafe, because three panes need the sidebar's width. There is a "Mail" entry in the main nav. Components in `src/components/mail/`: `MailSidebar`, `MailMessageList`, `MailSearchBar`, `MailThreadView`, `MailHtmlBody`, `MailAttachmentPreview`, `MailComposer`, `RecipientInput`, `MailLabelManager`, `MailSettings`, `Toasts`. The typed client is `src/lib/mailApi.ts`, which reuses `api.ts`'s `apiFetch`; the only change there was adding `export`. `src/lib/mailUtils.ts` holds display helpers and a browser-side copy of the address parser. `RichTextEditor.tsx` gained two **optional, additive** props, `toolbar="mail"` (alignment, undo/redo, clear formatting) and `minHeightClass`; the proposal and agreement editors pass neither and render exactly as before. All view state (mailbox, folder, label, search, open conversation) lives in the URL, so Back works and closing a conversation returns to the same search results.

### 32.2 Inbound (mail-worker/src/inbound.ts)

Envelope recipient → `+tag` stripped → active, inbound-enabled `mail_accounts` row. If there is none, the Worker calls `setReject("550 5.1.1 …")`, an explicit bounce rather than a silent drop. The **raw .eml is written to R2 first.** The message is then parsed (postal-mime: small, built for Workers, isomorphic so it's also unit-testable in Node). The dedupe key is the normalized Message-ID, with a SHA-256 fallback over sender/Date/subject/body. The thread comes from In-Reply-To then References (never from the subject). Attachments go to R2 individually; a failed write marks that attachment `storage_status='failed'` and still stores the message. Message, recipients, attachments, thread bookkeeping and the audit event are inserted in **one transactional `db.batch()`**. The envelope address is recorded as Bcc when we were blind-copied. Bodies over ~900 KB are truncated in the row with a visible note, because of D1's ~2 MB value limit; the full original stays in R2 and is downloadable via "Download original". **Junk:** Email Routing records SPF/DKIM/DMARC results but gives no spam score, so only `dmarc=fail` files a message in Junk; SPF-only failures don't, because forwarding breaks SPF. On any processing error the raw copy is kept, a `mail_inbound_failures` row is written, and then either the message is forwarded to `MAIL_FALLBACK_FORWARD` (if set) or the error is re-thrown so the delivery fails visibly instead of being accepted and lost.

### 32.3 Outbound (functions/_lib/mail/smtp.ts, send.ts)

- **A real SMTP client over `cloudflare:sockets`:** greeting, EHLO, STARTTLS (587) or implicit TLS (465), AUTH PLAIN or LOGIN, MAIL FROM (with SIZE), RCPT TO, DATA (dot-stuffed), QUIT. Port 25 is blocked by Cloudflare. Plaintext (`security: "none"`) is refused unless the host is localhost. CR/LF/`<>` in envelope addresses is rejected. Errors carry the SMTP code and the server's reply text but never AUTH payloads or a session transcript.
- **MIME:** multipart/alternative (text + HTML, quoted-printable UTF-8), multipart/related for cid: images, multipart/mixed for attachments (base64, wrapped at 76 columns), RFC 2047 names and subject, RFC 2231 filenames, and no Bcc header (Bcc exists only in the envelope).
- **Pipeline:** `queueOutboundMessage()` writes the message, recipients, send job and draft hand-over in one batch **before any SMTP traffic**, so a sent email always has a record. The Message-ID is generated once and reused on retries. The `idempotency_key` (UNIQUE, generated by the composer per compose session) makes a double-click or a retried request return the existing job. `attemptSendJob()` takes a lease with a conditional UPDATE. Outcomes:
  - 4xx, network error or timeout before end-of-data: `retry_scheduled` with backoff (1/2/4/8 min ±20%), up to 5 attempts.
  - 5xx, missing SMTP config, or a vanished attachment: `failed`, never auto-retried.
  - Connection lost after end-of-data, or a job still `sending` past its lease: `failed` as **"outcome unknown"**, never auto-resent, because the server may already have accepted it.
  - Manual retry (`POST /send/retry`) only accepts failed or retry_scheduled jobs and grants 3 more attempts.
  - Every attempt is a `mail_send_attempts` row.
  - The UI says "Accepted by the mail server" and never "delivered".
- The first attempt runs inline in the send request; later retries need the Worker's cron. **If the Worker isn't deployed, scheduled retries won't run** (manual retry still works).
- **Limits:** recipients per message, sends per staff member per hour (counted from `mail_send_jobs`), and attachment count/size are all set by policy (Mail settings → Security, owner/admin, within hard ceilings in `config.ts`). Executable extensions are refused on upload.

### 32.4 Security measures (checked explicitly)

- **Auth:** the existing middleware covers every route (verified: 401 with no cookie). Authorization is per-mailbox on every message, thread, draft, attachment, label and send path (verified: a staff member without a grant gets 404 on another mailbox's thread, message and attachment, and an empty identity list).
- **Sender identity:** From is always the identity's own address from the DB, never request input. A missing or unauthorized identity returns 404, read-only access returns 403, and a disabled identity returns 403.
- **Inbound HTML, two layers:**
  1. Server-side allowlist sanitizer on the Workers-native `HTMLRewriter`. It drops script/iframe/object/embed/form controls/svg/math/meta/link/base with their content, removes every on* handler and every non-allowlisted attribute, keeps only http/https/mailto/tel links (forced to `target=_blank` with `rel="noopener noreferrer"`), and strips @import/expression()/behavior/javascript:/`position:fixed` from CSS.
  2. A sandboxed `<iframe srcdoc>` **without allow-scripts**, plus a CSP meta (`script-src 'none'`). `allow-same-origin` is granted only so cookie-authenticated cid: images load and the frame height can be measured; without allow-scripts that pairing is safe.
- **Remote images:** blocked by default, with a per-message "Load remote images" button. The policy can be block / never / always.
- **Attachments:** downloads are always `application/octet-stream` with `Content-Disposition: attachment`, nosniff and a sandbox CSP. Inline preview is limited to png/jpeg/gif/webp/pdf/text; text is always served as `text/plain`, and HTML/SVG are never previewed.
- **Secrets:** SMTP credentials are only in env; `smtpStatus` returns just configured/not_configured, and nothing in any response or log includes a credential.
- **Injection:** header injection is rejected in addresses, Message-ID/In-Reply-To/References and subject (CR/LF collapsed). FTS queries are escaped (every term quoted). LIKE wildcards are escaped. SQL is fully parameterized; the only interpolated identifiers come from fixed whitelists.
- **Audit:** every write is logged in `mail_events` (moves, labels, sends, attempts, access and policy changes).

### 32.5 Environment / deployment (nothing here was done live from this session)

- **Pages project `clientkeeper`:**
  - Bindings: `DB` (existing) and new R2 `MAIL_ATTACHMENTS`.
  - Vars: `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT` (465 or 587), `MAIL_SMTP_USERNAME`, optional `MAIL_SMTP_SECURITY` and `MAIL_SMTP_EHLO_NAME`.
  - Secrets: `MAIL_SMTP_PASSWORD`, and optionally `MAIL_SMTP_PROFILES_JSON` for identities with their own SMTP login, referenced by `mail_accounts.smtp_profile`.
- **Worker `clientkeeper-mail-worker`:**
  1. Fill the two `REPLACE_ME` D1 values in `mail-worker/wrangler.toml`.
  2. Create the bucket: `npx wrangler r2 bucket create clientkeeper-mail-attachments`.
  3. Set the same SMTP vars in `[vars]` and `npx wrangler secret put MAIL_SMTP_PASSWORD`.
  4. Run `cd mail-worker && npm ci && npx wrangler deploy`.
- **Email Routing:** enable it for altasme.com (this replaces the MX records); add one routing rule per mailbox address, or a catch-all, with the action "Send to a Worker → clientkeeper-mail-worker". Optionally verify a fallback destination and set `MAIL_FALLBACK_FORWARD`.
- **SPF/DKIM for outbound** are the SMTP provider's records and must be published for altasme.com, or sent mail will land in recipients' spam. This is outside the code.
- **Order:** merge and run clienthub's schema first (`npx wrangler d1 execute <db> --remote --file=./d1/schema.sql`), then deploy this repo, then the Worker, then switch MX.

### 32.6 How this was tested

- **Unit tests** (new `npm test`, `node:test` via the new `tsx` devDependency, `tests/mail/`): **35 passing.**
  - The SMTP client against a scripted in-memory server: TLS/STARTTLS paths, AUTH PLAIN/LOGIN, 4xx → transient, 5xx → permanent, drop after DATA → unknown, credentials not echoed, CR/LF envelope injection refused, dot-stuffing.
  - MIME built by `mime.ts` and parsed back with postal-mime: non-ASCII subject and names, threading headers, a byte-exact PDF attachment, a cid: inline image, no Bcc header, CRLF-only output.
  - Address parsing and injection.
  - Reply/Reply-All rules.
  - Inbound normalization against a real multipart fixture, the dedupe fallback, and the junk heuristic.
  - Backoff, compose validation, SMTP config resolution, settings/policy whitelisting, FTS escaping.
- **Live end to end in workerd (local, not production):** both runtimes ran against one local D1 + R2, with the full clienthub schema applied, including FTS5:
  - `wrangler pages dev` for this app;
  - `wrangler dev --test-scheduled` for the mail worker;
  - a local SMTP sink on 127.0.0.1:2525;
  - a hand-minted `ck_session` cookie.

  Verified:
  - **Inbound** through the local `/cdn-cgi/handler/email` endpoint:
    - storing a multipart message;
    - a redelivery recorded as a duplicate (one row);
    - a DMARC-fail message filed in Junk;
    - `support+web@` routing to support@;
    - an unknown address rejected with 550;
    - raw copy and attachments present in R2, and FTS rows written.
  - **Sanitizer output in workerd:** script, on*, javascript:, iframe, @import and the tracking pixel removed; the cid: image rewritten to the preview route; two remote images counted as blocked; `remoteImages=1` restores the pixel but never the script.
  - **Authorization:** 401/403/404 as described in §32.4.
  - **Attachments:** download/preview headers; read-only access refused on send and draft.
  - **Mailbox actions:** label, star, archive, restore and the Trash-only permanent delete. Labels can't be applied across mailboxes (0 affected).
  - **Search:** FTS search including attachment-name and label-name matches.
  - **Drafts and replies:**
    - Reply-All prefill: the no-reply Cc was dropped, our own address excluded, the signature inserted, and the `<script>` stripped from the signature.
    - Autosave, with a stale version returning 409.
    - Upload, with `.exe` refused.
  - **Real SMTP sends** over `cloudflare:sockets` to the sink:
    - correct envelope and headers, the In-Reply-To/References chain, the reply in the same thread, the attachment on the wire;
    - replaying the same idempotency key returned `duplicate:true` with no second send;
    - the forward carried the original's attachments.
  - **Failure handling:**
    - 451 → `retry_scheduled`; 550 → `failed`;
    - manual retry of a 550 is still failed; retrying a sent message returns 409;
    - the cron run retried the due job (attempt 2);
    - a job artificially left `sending` past its lease was reaped as "outcome unknown".
  - **Settings:** policy and identity changes refused for sales (403), and out-of-range policy refused (400).
- **Browser (Playwright, system Chrome):**
  - Desktop at 1440 px: list, conversation, iframe sandbox attributes, header details, label chips, composer (chips with an invalid address blocking send, autosave reaching "Saved", send → "accepted by the mail server" toast), settings, search highlighting.
  - Mobile at 390 px: list, conversation, drawer, full-screen composer.
  - No horizontal overflow at either width, and zero console errors.
  - **This caught a real bug** that the API tests couldn't: clicking into the composer body put the caret after the auto-inserted signature, so the user typed inside it. Fixed by moving the caret to the leading paragraph on the first pointer-up or keyboard focus, and re-verified (the text now lands above the signature).
- `npm run build`, `npm run lint`, `npx tsc -p functions/tsconfig.json --noEmit` and `mail-worker`'s `tsc` are all clean. All scratch tooling (root `wrangler.toml`/`.dev.vars`, the Worker's local test toml, `.wrangler` dirs, the SMTP sink, Playwright scripts) was removed or stopped.

### 32.7 Not verified / known limitations / not built

- **Never run against real infrastructure:** no real SMTP provider, Email Routing, production D1 or R2 (no credentials or network path from this session). Specific unknowns:
  - real-world TLS/STARTTLS against the chosen provider;
  - provider-specific auth quirks;
  - the provider's message-size limit relative to the 25 MB attachment policy;
  - Email Routing's exact behavior when the Worker throws.

  Send one test message each way before switching MX.
- Messages with no Message-ID: the local Email Routing simulator refuses them (real Email Routing likely does too), so the hash dedupe fallback is covered by unit tests only.
- **Auto-refresh polls** (default 45 s, 4× slower in a background tab); there is no realtime push. Notifications are in-page toasts, an optional sound, and optional desktop notifications.
- Spam filtering is the DMARC-fail rule only (no scoring, no per-sender block list). There is no antivirus scan of attachments; only executable extensions are blocked.
- `mail_inbound_failures` has **no UI yet**; check it by querying D1. Raw copies of failed messages live under `failed/` in R2.
- **Drafts are private to their author**, even in a shared mailbox (a deliberate choice).
- Not built:
  - a resizable composer (only minimize/maximize/full screen);
  - a bottom reading pane (only "right" or "full");
  - an image-insert button in the editor (signature logos only via pasted HTML or an https image URL in the HTML);
  - an "empty Trash" one-click (select all → Delete forever does it; the Worker also purges Trash after 30 days).
- Conversation-row actions apply to the messages that matched the current view, not to messages of that thread sitting in other folders. Junk/Trash messages are hidden from an Inbox conversation view.
- The send rate limit is a D1 count per user per hour, not a distributed limiter (fine at staff scale).

---

## 33. Webmail backend extracted into a standalone, importable package: `@altasme/webmail-kit` [2026-11-24, same day]

Per the operator's direct request after the `/mail` module went live and was confirmed working end to end (real inbound mail received, a real outbound reply sent and received), the fully app-agnostic parts of §32's build were pulled out into their own repo, `altasme/webmail`, so the next project that needs staff webmail imports it instead of rebuilding it from scratch.

**What moved, and what didn't.** Of the whole mail library, only two files (`access.ts`, `route.ts`) had a real app-specific dependency: an import of this repo's own `StaffUser` type from `../roles`. Everything else -- `address`, `threading`, `mime`, `smtp`, `smtpTransport`, `sanitize`, `text`, `actions`, `compose`, `config`, `detail`, `drafts`, `events`, `http`, `query`, `send`, `sendRoute`, `storage`, `store`, plus the standalone Worker's `inbound.ts`/`parse.ts`/`index.ts` -- had zero imports outside the mail lib itself (confirmed by grep before moving anything, not assumed). The two coupled files were genericized, not left behind: `access.ts` now exports a minimal `MailUser { id, role }` interface in place of `StaffUser`, and `route.ts`'s `mailHandler()`/`MailContext`/`MailHandlerArgs` became generic over `<U extends MailUser>` (defaulting to `MailUser`) instead of hardcoding `StaffUser`. This repo's own concrete `StaffUser` already satisfies `MailUser` structurally (its `role: StaffRole` is a string-literal union, assignable to `role: string`), so nothing about this repo's actual typing got looser.

**This repo now consumes the package for real, not just alongside a duplicate local copy.** `functions/_lib/mail/` (all 20 files) and `mail-worker/src/{inbound,parse}.ts` are deleted outright. `package.json` and `mail-worker/package.json` both depend on `@altasme/webmail-kit` pinned to a specific commit SHA (`github:altasme/webmail#<sha>`, not tracking `main`, per that repo's own stated convention against letting a dependency silently change under a production app). `mail-worker/src/index.ts` is now a one-line re-export of the package's ready-made Worker entry (`export { default } from "@altasme/webmail-kit/worker"`) rather than its own `email()`/`scheduled()` implementation.

**New local adapter, `functions/_lib/mailHandler.ts`** -- the one file in this repo allowed to bridge the package's generic `MailUser` to this repo's concrete `StaffUser`, so every one of the ~35 route files gets full typing on `args.user` (real `email`/`full_name`/`role: StaffRole` fields, not just the minimal `MailUser` shape) without repeating a generic type parameter at every call site. Every route file was mechanically rewritten (a one-off Python script, not hand-edited one by one, to guarantee consistency across 34 files) to import `mailHandler` (and, in one file, `MailHandlerArgs`) from this local adapter, and every other name (`isMailAdmin`, `jsonResponse`, `listThreads`, etc.) from the package's default barrel export.

**A real bug caught during this refactor, not present in the original build:** the package's default barrel (`@altasme/webmail-kit`) transitively re-exports `sendRoute.ts` → `smtpTransport.ts`, whose top-level `import { connect } from "cloudflare:sockets"` Node's own ESM loader rejects outright (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). That's invisible to the Pages Functions routes and the Worker (both run in the real Workers runtime, where `cloudflare:sockets` exists), but it broke this repo's own `tests/mail/*.test.ts` the moment they were pointed at the barrel instead of the original per-file relative imports -- ES module imports evaluate eagerly, so even a test that only wanted `dedupeAddresses` from `address.ts` failed to load at all. Fixed on the package side (not worked around here): `@altasme/webmail-kit`'s `package.json` gained an explicit `exports` entry for every individual module (`./address`, `./smtp`, `./config`, etc.), and this repo's test files were updated to import the specific subpath each test actually needs (restoring the exact granularity the pre-extraction tests already had), while the real app code keeps using the convenient single barrel. See `altasme/webmail`'s own `docs/architecture.md` ("Importing: the barrel vs. per-module subpaths") for the full explanation -- this is now documented there so the next consumer doesn't rediscover it the same way.

**How this was tested:** `npx tsc -p functions/tsconfig.json --noEmit` (Pages Functions), `npm run build` (`tsc -b && vite build`, the frontend), `npm run lint` (`oxlint`), and `npm test` (`tsx --test tests/mail/*.test.ts`, all 35 passing) all ran clean after the refactor -- not just "the extraction typechecks in isolation," but this repo's actual full existing verification suite, re-run against the real installed package. `mail-worker`'s own `npx tsc -p tsconfig.json --noEmit` (a separate `npm install`, since it's a distinct deployable unit with its own `node_modules`) also passed clean. Confirmed via `git status` that only the intended files changed: the 20 deleted `_lib/mail/*` files, the two deleted worker files, 34 modified route files (import rewrites only), the new `mailHandler.ts` adapter, `mail-worker/src/index.ts` (replaced with the re-export), `mail-worker/tsconfig.json` (dropped its now-nonexistent extra `include` path), both `package.json`/`package-lock.json` pairs, and a handful of now-stale code comments (`MailHtmlBody.tsx`, `mailUtils.ts`, `tests/mail/fakeSmtp.ts`, `messages/index.ts`) updated to point at the package instead of the deleted local path.

**Not re-verified by this round, since nothing about the actual runtime behavior changed:** the live Cloudflare deployment (Worker + Pages project) still needs this refactor's code redeployed before it's actually running the extracted package in production -- the real SMTP send/receive round-trip already confirmed working in §32 was against the pre-extraction code, and redeploying is the next step, not yet done as part of this write-up.

**Known open items:**
- `@altasme/webmail-kit` is pinned to a specific commit, not a tagged release -- pushing a git tag to that repo failed from this sandbox (a transient `403`/RPC disconnect on `git push --tags`, not investigated further since pinning to a commit SHA is just as reproducible). Worth tagging a real `v1.0.0` from a normal environment if that matters later.
- The package has not yet been consumed by a *second* real project -- this extraction's only consumer so far is this repo, so the generic `MailUser` boundary (and the per-module subpath fix above) is tested by one real integration, not two independent ones.

---

## 34. Email Services: client email hosting managed from ClientKeeper (Phases 1–3 + provider interface) [2026-11-25]

The operator's "Altaventures Email Ecosystem" spec expands email from Altaventures' own staff mailboxes (§32/§33) into email hosting sold to clients: plans, mailbox allowances, domains, and mailboxes created at a third-party provider (Z.com first). This round builds the **ClientKeeper master panel and the engine behind it**. Schema lives in clienthub's `d1/schema.sql` (clienthub CLAUDE.md §31).

**Scope decisions made by the operator (not re-asked):**
1. **No Z.com credentials or API documentation exist yet.** Everything is built against a generic provider interface. The only implementation is an honest placeholder that fails every call with `not_configured`. Nothing about Z.com's real API is guessed.
2. **`mail.altasme.com` is this same app** on a second custom domain, not a second deployment. The DNS/custom-domain step is not done here (no Cloudflare access). One code fix it needs was made (§34.6).
3. **In scope:** the audit, the schema, ClientKeeper's Email Services module, the entitlement engine, and the provider interface. **Not in scope:** the client-facing "Email Management" module in clienthub (Phase 5), the `mail.altasme.com` domain wiring (Phase 6), and the real Z.com adapter.
4. **Confirmed mid-round:** client mailboxes will eventually be read and sent through *this* app's own webmail (`/mail`), not Z.com's bundled webmail. The bridge isn't built, but the schema leaves room for it (§34.2).

### 34.1 What exists vs. what's new

- **The webmail (§32/§33) is a different system** and is untouched. `mail_*` tables hold Altaventures' own altasme.com mailboxes, received through Cloudflare Email Routing. The new `email_*` tables hold client subscriptions and provider-hosted mailboxes. Nothing in this round links the two yet.
- **Reused:** clients (`clients.id`; client identity is never duplicated), staff auth (`_middleware.ts` + `StaffUser`), `client_activity` for the client timeline, the shared `audit_log` for plan-catalog edits, and the self-contained route + `_lib` module conventions.
- **New library `functions/_lib/emailServices/`:**
  - `provider/` holds the interface (`types.ts`), the placeholder (`notConfigured.ts`), the registry (`index.ts`), and the timeout/exception wrapper (`call.ts`).
  - `policy.ts`: statuses, counted mailbox states, lifecycle rules, effective expiry, owner/admin role check.
  - `engine.ts`: every state change (reserve/provision/retry/delete/discard/resolve, entitlements, plans, domains, lifecycle, sync, sweeps).
  - `reconcile.ts`: a pure local-vs-provider diff.
  - Also `services.ts` (create + read models), `plans.ts`, `logs.ts`, `validation.ts`, `http.ts`, `responses.ts`.

### 34.2 Data model (summary; full comments in clienthub's schema)

| Table | Purpose |
|---|---|
| `email_plans` | Editable plan catalog, seeded with Solo/Team/Growth/Business/Enterprise and ₱250 additional mailbox |
| `email_services` | One subscription per row, `client_id` → `clients` |
| `email_service_entitlements` | Signed-quantity ledger of add-ons and overrides |
| `email_domains` | Domains per service; a domain can be live on only one service |
| `email_mailboxes` | One row per mailbox; the row is both the state machine and the reservation |
| `email_provisioning_logs` | Every provider call: outcome, normalized error, retryable |
| `email_audit_logs` | Security-relevant actions, with `actor_type` staff / client / system |

Design notes:
- **Plan values are snapshotted onto the service when assigned.** A later catalog edit doesn't change what an existing customer has.
- **The total allowance is never stored.** It is always `included_mailboxes + SUM(entitlements)`, computed inside the statement that consumes a slot.
- **There is no separate reservations table.** A `reserved` mailbox row with a `reserved_until` lease *is* the reservation.
- **Mailbox states:** `reserved → provisioning → active | failed | needs_review`, plus `deleting → deleted` and `failed → discarded`.
- **States that count against the allowance:** provisioning, active, needs_review, deleting, and reserved while its lease is live.
- **"Active mailboxes" shown to anyone means `active` only.** Held-but-unconfirmed slots are shown separately as "pending".
- **No password column anywhere.** Passwords go straight to the provider. Retry asks for the password again.
- **Webmail-bridge room (per the confirmed requirement), not used yet:**
  - `email_mailboxes.inbound_source`: `cloudflare_email_routing` | `zcom_poll_sync`. Z.com mailboxes get `zcom_poll_sync`, because Z.com has no generic new-mail push.
  - `provider_service_id` / `provider_mailbox_id` hold Z.com's opaque `service_id` / `email_id` per mailbox.
  - Nullable `mail_account_id → mail_accounts(id)` links a mailbox to its webmail identity once bridged. Outbound will then use that identity's `smtp_profile` against Z.com's SMTP host, since Z.com's API has no send endpoint.
- **Storage** is a plain integer (MB). It assumes nothing about Z.com's 5 GB service-level steps, which don't match 3/10/30/100 GB; that mismatch is an open business question.

### 34.3 Entitlement engine and race safety

Every limited-resource check sits **inside the single SQL statement that consumes the resource**. D1 runs each statement atomically and serializes writes, so two simultaneous requests can't both take the last slot.

| Operation | How the check is done |
|---|---|
| Reserve a mailbox | `INSERT … SELECT … WHERE` checks service status ∈ (pending_setup, active, provisioning_error), plan present, `expires_at` in the future, domain live on this service, and allowance > counted |
| Retry a failed mailbox | Conditional `UPDATE` with the same checks |
| Entitlement changes | Conditional `INSERT … SELECT` that refuses to go below counted usage or below zero add-ons |
| Plan changes | Conditional `UPDATE … FROM email_plans` with the same below-usage guard |
| Domain removal | Conditional `UPDATE … WHERE NOT EXISTS (counted mailboxes)` |
| Decommission | The status `UPDATE` repeats the "no counted mailboxes" check |

The provider is called **between** two statements, never inside a transaction (same pattern as `mail_send_jobs`). Outcomes:
- success → `active`;
- a definite failure (`not_performed`) → `failed`, and the slot is released;
- an unknown outcome (timeout, adapter exception, crash) → `needs_review`, and the slot is **held**;
- a provider `duplicate` answer → also held as `needs_review`.

`needs_review` is only cleared by an explicit admin "Resolve" (exists → active, absent → failed/deleted), never automatically.

**Idempotency:** a client-generated `idempotencyKey` (UNIQUE) makes a double-submit return the existing row without a second provider call. Unique violations check the key first, because SQLite may report the address index before the key index.

**Uniqueness:** partial unique indexes allow one live record per address and one live primary per service.

**Time-based rules, applied lazily** (Pages has no cron) on every list/detail read and before every provisioning decision:
- a stale `reserved` (provider never called) becomes `failed`;
- a stale `provisioning`/`deleting` becomes `needs_review`;
- an `active` service past `expires_at` becomes `expired`. Provisioning checks `expires_at` directly anyway, so an expired term can't provision even before the sweep runs.

### 34.4 Lifecycle (`policy.ts`)

| Action | Allowed from | Requirements and effect |
|---|---|---|
| Activate | pending_setup, provisioning_error | Needs plan + live domain + ≥1 **active** mailbox. Sets start/expiry. |
| Suspend | active, expired | Reason required. Blocks new mailboxes. Deletes nothing. |
| Reactivate | suspended | Only while the term is still running. |
| Renew | active, expired, suspended | +1 billing interval from the later of now and current expiry, or an explicit date. expired → active. Mailboxes aren't recreated. |
| Decommission | anything but cancelled | Reason required. Every mailbox must be deleted/resolved first. Releases domains. |

Other rules:
- A failed **primary** mailbox on a pending service sets `provisioning_error`. A later success returns the service to `pending_setup`.
- Expiry never touches mailboxes.
- Staff keep full inspect/manage ability in every state but `cancelled`.
- `clientCanManageMailboxes()` already exists for Phase 5 (effective status `active` only).

### 34.5 Provider interface and the placeholder

`EmailHostingProvider` methods:

| Method | |
|---|---|
| `status` | integration configured or not |
| `listDomains` | |
| `listMailboxes` | |
| `getMailboxDetails` | |
| `createMailbox` | gets a stable idempotency key (the mailbox id) |
| `deleteMailbox` | |
| `changeMailboxPassword` | in the interface; no admin UI this round |
| `configureForwarding` | in the interface; no admin UI this round |
| `getServiceDetails` | |
| `getUsage` | |

- **Results are values, not exceptions:** `{ ok, value } | { ok: false, error: { code, message, outcome: 'not_performed' | 'unknown', retryable } }`.
- **Normalized error codes:** `not_configured`, `not_supported`, `auth_failed`, `rate_limited`, `timeout`, `unavailable`, `duplicate`, `invalid_input`, `not_found`, `quota_exceeded`, `provider_error`.
- **`callProvider()`** adds a 20 s timeout and turns any thrown error into `outcome: 'unknown'`.

**`NotConfiguredProvider`** (headed by a banner comment: "NOT A WORKING INTEGRATION") returns `not_configured` / `not_performed` / non-retryable for every method. It never returns success or invents an id. `getEmailProvider()` always returns it today.

**To add Z.com:** write `provider/zcom.ts` against the real documentation, then return it from `getEmailProvider()` only when its secrets exist. Nothing outside `provider/` changes.

What a staff member sees today:
- Creating a mailbox returns **503 "Email provider not configured…"**. The mailbox is recorded as `failed` and its slot is released.
- Sync records an error. A permanent amber "Provider not connected" banner is shown.

### 34.6 Routes and UI

**API**, all under `/api/app/` and behind the existing middleware. Every route is viewable by any staff role; every mutation requires owner/admin.

| Route | Methods |
|---|---|
| `email-services` | GET (list), POST (create) |
| `email-services/operations` | GET: failed/unknown provider operations across services |
| `email-services/:id` | GET (detail), PATCH (notes, provider service id, expiry; reason required to change expiry) |
| `…/plan` | POST |
| `…/domains` | POST |
| `…/domains/:domainId` | DELETE |
| `…/entitlements` | POST |
| `…/mailboxes` | POST (201 active / 200 duplicate / 202 outcome unknown / 503 not configured / 502 other provider failure / 409 no slot) |
| `…/mailboxes/:mailboxId/retry` | POST |
| `…/mailboxes/:mailboxId/delete` | POST (reason required) |
| `…/mailboxes/:mailboxId/discard` | POST |
| `…/mailboxes/:mailboxId/resolve` | POST |
| `…/lifecycle` | POST |
| `…/sync` | POST: displays discrepancies only, never changes a mailbox |
| `…/logs` | GET |
| `email-plans` | GET, POST |
| `email-plans/:planId` | PATCH (incl. archive; plans are never deleted) |

A mailbox or domain addressed through the wrong service returns 404.

**Frontend:**
- An "Email Services" nav item (before Billing) and three code-split pages (`React.lazy`). Lazy loading keeps the main chunk at ~469 kB; inlining them pushed it past Vite's 500 kB warning.
- `EmailServicesPage`: list, search/filter, a "Failed operations" tab, and a create modal.
- `EmailServiceDetailPage`, with the spec's sections: Overview (+ activation checklist), Mailbox usage, Mailboxes (retry/discard/resolve/delete per state), Domains, Plan & entitlement (with the ledger), Provider (+ Sync & reconcile and discrepancy list), Operations (lifecycle buttons valid for the current state), and Logs.
- `EmailPlansPage`: the catalog editor.
- Typed client: `src/lib/emailServicesApi.ts`.

**Hostname fix for `mail.altasme.com` (the one real cross-host break found in the audit):**
- `auth-start.ts` hardcoded `redirect_uri=https://clientkeeper.altasme.com/api/auth-callback`, and `auth-callback.ts` hardcoded its landing URL.
- The session cookie is host-only (no `Domain=`, which is correct and was left alone). So a login started on `mail.altasme.com` would have set the cookie on `clientkeeper.altasme.com`, and the user would never be logged in on the mail host.
- New `functions/_lib/hosts.ts` allowlists `clientkeeper.altasme.com` (lands on `/`) and `mail.altasme.com` (lands on `/mail`). Any other host (previews, spoofed `Host:`) falls back to the exact previous behavior, so the redirect target can't be steered.
- **Before attaching the domain:** add `https://mail.altasme.com/api/auth-callback` to the WorkOS dashboard's allowed redirect URIs.
- No other absolute `clientkeeper.*` URLs or CORS dependencies exist; the API is same-origin by construction.

### 34.7 How this was tested

**Unit + engine tests:** `npm test` now also runs `tests/emailServices/*.test.ts`. **66/66 pass** (35 existing mail + 31 new).
- The engine runs against a real SQLite (Node's built-in `node:sqlite`) through a small D1-compatible shim (`tests/emailServices/d1Shim.ts`). Batches are transactional, and every call yields to the event loop so concurrent calls genuinely interleave.
- The schema comes from `tests/emailServices/schema.fixture.sql`, the Email Services block copied verbatim plus its referenced tables. A drift-guard test fails if that block stops matching a sibling `clienthub` checkout. The suite also passes against the full canonical schema (`EMAIL_TESTS_USE_CLIENTHUB_SCHEMA=1`).
- **Concurrency:** 10 simultaneous requests against 3 slots create exactly 3, and the provider is called exactly 3 times. A deliberate negative control (a naive check-then-insert under the same shim) *does* oversubscribe, proving the test can catch the race. A duplicate idempotency key sent concurrently produces one row and one provider call. The test passed 5/5 repeated runs.
- **Also covered:**
  - the placeholder fails all 9 operations honestly;
  - stub provisioning releases its slot and sets provisioning_error, and the password appears in no table;
  - unknown outcome and provider duplicate hold the slot, and "resolve absent" releases it;
  - retry in place, and retry refused when the slot was taken;
  - discard;
  - the lease sweeps;
  - a delete refused by the provider restores the mailbox, and a confirmed delete releases the slot;
  - add-on/override rules, plan snapshotting, downgrade-below-usage refusal;
  - domain conflicts and in-use removal;
  - the full lifecycle, plus expiry blocking provisioning before the sweep and renew restoring it;
  - sync reporting discrepancies without changing mailboxes;
  - reconcile classifying all discrepancy types;
  - validation, plan validation, `callProvider` timeout/throw, and the auth host allowlist.

**Live in workerd (local only):** `wrangler pages dev` with the full canonical schema applied to a local D1 and hand-minted `ck_session` cookies (owner + sales).
- 29 HTTP scenarios checked:
  - 401 with no cookie; 403 for sales on every mutation; 400 validation;
  - 503 not_configured provisioning recorded as failed with the slot released; a repeated idempotency key returned 200;
  - the `operations` static route resolving ahead of `[serviceId]`;
  - entitlement and plan refusals; `UPDATE … FROM` working in workerd;
  - activation checklist enforcement, invalid transitions, and sync reporting not_configured;
  - a 404 for a cross-service mailbox; domain conflicts surfaced as a warning;
  - decommission requiring a reason; plan CRUD and archived-plan refusal.
- With a mailbox seeded `active` to fill a Solo plan: single and 8-way parallel provisions all returned 409 with no stray rows. Domain removal and decommission were refused while in use.
- A forced past `expires_at` was swept to `expired`, provisioning was refused, the mailbox stayed `active`, and renew restored it.
- A password-leak query across all three email tables found 0 rows.
- `auth-start` produced the right `redirect_uri` for each Host header.

**Browser:** Playwright with system Chrome at 1440 and 390 px over the list, detail and plans pages, the create modal and the failed-operations tab. No horizontal overflow and no console errors other than an intentional 409. Provisioning through the UI showed the not-configured message, and the logs rendered.

**Build and lint:** `npm run build`, `npm run lint` (clean), and `npx tsc -p functions/tsconfig.json --noEmit` all pass.

**Cleanup:** all scratch artifacts (root `wrangler.toml`/`.dev.vars`, `.wrangler`, local D1, cookie minter, Playwright script) were removed.

### 34.8 Not done / open items

- **Real Z.com adapter:** waiting on credentials and documentation. Mailboxes can't become active until it exists.
- **Phase 5 (client "Email Management" in clienthub):** not built. The tables, `clientCanManageMailboxes()`, and `actor_type='client'` are ready for it.
- **Phase 6 (`mail.altasme.com`):** add the custom domain to the clientkeeper Pages project, and add the WorkOS redirect URI (§34.6). Optionally redirect `/` to `/mail` on that host.
- **Webmail bridge** (polling sync for Z.com inbound, `mail_accounts` link, per-mailbox `smtp_profile`): schema room only.
- **Not done this round:**
  - a cron-driven expiry/lease sweep (sweeps are lazy on read and before writes);
  - billing integration for add-ons (the ledger records unit price, but nothing charges);
  - storage-quota enforcement;
  - a configurable expiry "grace" policy (expiry blocks new mailboxes and changes nothing else);
  - admin UI for password reset and forwarding (they exist in the interface).
- **Production:** run clienthub's schema migration before deploying this; nothing here has run against production D1.

## 35. Email Services: manual Z.com fulfillment, client mailbox requests, and the inbound poll-sync bridge [2026-11-26]

The operator's decision, verbatim: *"i will set up the email account in z.com and provide you the needed infos. Then the client: - If they have an email account allowance, they can request it along with their requested email account name, then i will process it manually. Then I'll just put it in clientkeeper."* plus *"we'll set aside the adaptor for this process, you still configure the things on the cloudflare side. Whatever we can do on clientkeeper to ease the process, we do it."*

So there is still **no real Z.com adapter** (`provider/zcom.ts` does not exist). A human creates each mailbox in Z.com's own dashboard; this round builds the software around that step. Mid-round correction: the client-facing side is a separate, not-yet-specified platform, **not clienthub** — nothing was built in clienthub, and no client route calls `requestMailboxByClient` yet.

### 35.1 Engine (`engine.ts`, "Manual fulfillment" section)

| Function | Transition | Notes |
|---|---|---|
| `requestMailboxByClient` | → `reserved`, `reserved_until = NULL`, `created_by_type = 'client'` | Never calls a provider. Same atomic `INSERT … SELECT` as `provisionMailbox`, plus `s.client_id = ?` (the real ownership boundary) and **one pending client request per service** (`NOT EXISTS` in the same statement). Allowed in the provisionable states (not `clientCanManageMailboxes()`'s active-only rule, which would block a new service's first mailbox). Idempotency/`address_taken`/`primary_exists` handled as in `provisionMailbox`. |
| `fulfillMailboxManually` | `reserved` \| `needs_review` \| `failed` → `active` | Staff only (checked in the function and the route). Staff-entered `provider_mailbox_id`/`provider_service_id`. A `failed` row re-checks state, domain and capacity in the same conditional `UPDATE` (like retry). By default creates or reuses the `mail_accounts` row for the address (`smtp_profile` = the given key; an existing row keeps its own), grants the acting staff member `mail_account_access`, and sets `mail_account_id`. **No password field exists, by design.** A second fulfill returns 409 `already_fulfilled` and writes nothing; two simultaneous ones have one winner. If the bridge/log batch fails after the claim, the mailbox is put back as it was. |
| `declineMailboxRequest` | client `reserved` → `discarded` | Staff only, reason required. `failure_code = 'declined_by_staff'`. `discarded` frees the address immediately. |

**Allowance rule change (`policy.ts`):** `COUNTED_MAILBOX_SQL` / `mailboxCountsAgainstAllowance` now count a `reserved` row with **no** lease (`reserved_until IS NULL`) as well as one with a live lease. That is what makes a client request hold its slot. The sweep never touches it (`NULL <= ?` is never true) and `runProvisioning` never claims it (`reserved_until > ?`). `services.ts`'s list query now uses the shared fragment instead of an inline copy. **Doc drift to fix in clienthub later:** the `email_mailboxes` comment in `clienthub/d1/schema.sql` still says "reserved while its lease is live". It's comment-only (no migration), but the drift-guard test compares that block verbatim, so it must be changed in both files together; it was deliberately left alone here because clienthub was out of scope.

### 35.2 Staff routes and UI

- `POST …/mailboxes/:mailboxId/fulfill` `{ providerMailboxId, providerServiceId?, smtpProfileKey?, createBridgeAccount?, bridgeDisplayName? }`. A body containing `password` is refused (400).
- `POST …/mailboxes/:mailboxId/decline` `{ reason }`.
- Both owner/admin via the existing `requireEmailAdmin`.
- `EmailServiceDetailPage`: a "Requested by client" badge plus "Awaiting setup" status, "Fulfill manually" on any reserved/needs-review/failed row, "Decline" on client requests, and "Linked to webmail" under bridged addresses. `src/components/emailServices/FulfillMailboxModal.tsx` prefills the service's provider id and a default key `client-<service-id-prefix>-<local-part>`, and shows a concrete runbook (create in Z.com → set password there → give Claude host/port/username/password + the exact key for `MAIL_SMTP_PROFILES_JSON` → DNS for the domain).

### 35.3 Provider interface

`listMessages`, `getMessageDetails`, `getAttachment` (read-only), with `ProviderMessageSummary` / `ProviderMessageDetails`. `NotConfiguredProvider` stubs all three honestly. **Unverified assumption:** Z.com's docs show no example value for a message's content field. `ProviderMessageDetails.rawMime` assumes raw MIME; an adapter that gets something else sets it to null and fills `bodyText`/`bodyHtml`. Correct this against a real Z.com response before trusting the sync.

### 35.4 Inbound poll sync (`mail-worker/src/zcomPollSync.ts`)

- `mail-worker/src/index.ts` is now a custom entry: `email()` and `scheduled()` delegate to `@altasme/webmail-kit/worker`'s own default handler unchanged, and `scheduled()` also runs `runZcomPollSync`. The package itself was not modified.
- The provider comes from `functions/_lib/emailServices/provider` (imported directly, as this worker imported `functions/_lib/mail/*` before the package existed). It's the placeholder today, so **the sync skips itself silently** until a real adapter exists.
- Per tick: up to 5 active, bridged `zcom_poll_sync` mailboxes not attempted in the last 5 minutes (oldest attempt first, from the `message_sync` log, so a failing mailbox can't starve the rest). One `listMessages` (newest 50), then up to 10 unseen messages each.
- Each message goes through the package's `processInbound()` (raw MIME as-is; otherwise a MIME message rebuilt with the package's `buildMimeMessage`, fetching attachments only when `hasAttachments`). Same D1/R2 rows as Email Routing mail; `UNIQUE(account_id, dedupe_key)` handles duplicates.
- Stored messages get a `mail_events` row (`zcom_poll_synced`, provider message id in `event_data`), so a known id is skipped with no further provider call. No schema change.
- One `email_provisioning_logs` row (`message_sync`) per mailbox per poll. `last_synced_at` moves only on a fully successful pass. Per-mailbox failures are caught and logged; the batch continues.
- Limitation: more than 50 new messages for one mailbox between its passes → the older ones are missed (no "since" filter, no paging).

### 35.5 How this was tested

- `npm test`: **84/84 pass** (66 existing + 1 new policy assertion + 12 manual-fulfillment + 6 poll-sync), also with `EMAIL_TESTS_USE_CLIENTHUB_SCHEMA=1`. The fixture gained the webmail tables these paths write (copied verbatim, above the drift-guarded block).
- Covered: ownership (incl. a negative control proving the INSERT's `client_id` clause is what refuses a service that changes hands mid-request), 10-way concurrent requests (one pending, capacity holds), the held request blocking an allowance drop, decline freeing the address, fulfill → bridge account + access grant, a credential scan over every touched table, double/concurrent fulfill, reuse of an existing `mail_accounts` row, recovering a failed primary (refused when the slot is taken; clears `provisioning_error`; enables activation). Poll sync: placeholder skip, storage through `processInbound`, known-id skip, dedupe duplicate, per-mailbox isolation, attachments fetched only when flagged, per-tick bounds and the poll interval.
- `npx tsc -p functions/tsconfig.json --noEmit`, `npm run lint`, `npm run build`, `mail-worker` `npm run typecheck`, and `wrangler deploy --dry-run` (bundle only, nothing deployed) all pass.
- **Not done:** no browser pass over the new modal and no `wrangler pages dev` run of the two new routes this round.

### 35.6 Operator checklist (outside this codebase)

1. For each mailbox: create it in Z.com, set its password there, then "Fulfill manually" in ClientKeeper.
2. Add its SMTP login to the mail worker's `MAIL_SMTP_PROFILES_JSON` secret under the exact key shown (`{"<key>": {"host","port","security","username","password"}}`), and the same on the Pages project if staff send from it in `/mail`; redeploy.
3. New domain: publish Z.com's MX/SPF/DKIM in Cloudflare DNS.
4. Inbound sync does nothing until a real Z.com adapter exists (credentials + a token mechanism).

## 36. Email Services: mailbox request links (the caller `requestMailboxByClient` was missing) [2026-11-26]

§35 left `requestMailboxByClient` with no caller. The operator's decision: no clienthub page. It works like the proposal/questionnaire links. Staff generate a one-time, token-gated link for one email service, send it by hand (chat, email), and the client opens `https://www.altasme.com/mailbox-request/<slug>?t=<token>` on the marketing site, picks a name, and submits. No login, no account.

### 36.1 Who does what

| Piece | Where |
|---|---|
| `mail_request_links` table | clienthub `d1/schema.sql` (end of the Email Services block; copied verbatim into `tests/emailServices/schema.fixture.sql`, drift-guarded as before) |
| Create / list / revoke | here: `functions/_lib/emailServices/requestLinks.ts` + `functions/api/app/email-services/[serviceId]/request-links/` |
| The reservation | altaventureswebsite: `functions/api/public/mailbox-request/` (its CLAUDE.md §74). A separate deployable, so it carries its own copy of `requestMailboxByClient`'s `INSERT … SELECT`, with a cross-reference comment pointing here |

**If you change `requestMailboxByClient`'s reservation statement, `COUNTED_MAILBOX_SQL`, `PROVISIONABLE_SERVICE_STATUSES` or `normalizeLocalPart`, change the marketing site's copies too** (`functions/_lib/publicDocs.ts` and the submit route there). They decide who gets a paid slot.

### 36.2 Staff side

- `GET …/request-links` (any staff role): every link for the service, newest first, with the full URL, creator, and, for a used link, the address of the request it created.
- `POST …/request-links` `{}` → 201 `{ link }`. Owner/admin (`requireEmailAdmin`). Refused (409) when the client couldn't use it: no plan, no active domain, or the service isn't provisionable (`canProvisionMailbox`, so an `active` service past `expires_at` counts as expired). The public route re-checks all of it atomically anyway.
- `POST …/request-links/:linkId/revoke` → `open` → `revoked`, one conditional `UPDATE`. 409 `link_used` (decline the request instead) or `link_revoked`. Owner/admin.
- Slug and token come from `_lib/publicDocs.ts`'s `generateUniqueSlugAndToken` (now also accepts `mail_request_links`), so the token is the same 8-character scheme proposals use. Slug base is the client's business name.
- Both mutations write `email_audit_logs` (`mailbox_request_link_created` / `_revoked`).
- **A link carries no domain.** The client picks among the service's active domains on the public page, so a link sent before staff add a second domain still offers both.
- `EmailServiceDetailPage`: a "Mailbox request links" card below Mailboxes with "Generate mailbox request link" (disabled with the reason as a tooltip when there's no plan/domain or the state is wrong), Copy link / Revoke on open links, and used/revoked links behind a toggle. The request a link creates shows up in Mailboxes exactly like any client request ("Requested by client", Fulfill manually / Decline).

### 36.3 What the public side does (summary; details in altaventureswebsite §74)

The resulting row is exactly what `requestMailboxByClient` creates: `reserved`, `reserved_until = NULL`, `created_by_type = 'client'`, `created_by` = the service's `client_id`, never primary, no provider call. Link `open` → `used` (with `used_mailbox_id`) in the same D1 batch, conditional on the row existing. The link's `status = 'open'` is checked inside the INSERT, which is the ownership boundary in place of `s.client_id = ?`. The audit row is `mailbox_requested_by_client` with `actor_type = 'client'`, plus `{ via: "request_link", linkId }` in `after_json`.

### 36.4 How this was tested

- `tests/emailServices/requestLinks.test.ts` (6 tests): create (unique slugs `acme-ph`, `acme-ph-2`; distinct tokens; the `https://www.altasme.com/mailbox-request/…` URL; audit rows), refusals (no plan, no domain, suspended, expired-by-date, unknown service, non-staff actor), revoke (once; `link_used`; wrong service → 404), list showing a used link's address, and the routes' owner/admin gate (403 for `sales` on create/revoke, 200 on list).
- `npm test`: **90/90** with `EMAIL_TESTS_USE_CLIENTHUB_SCHEMA=1` against the updated clienthub schema (drift guard included); 89 pass + 1 skip (the drift guard) on the fixture alone. `npx tsc -p functions/tsconfig.json --noEmit`, `npm run lint`, `npm run build` pass.
- End to end with the marketing site: two `wrangler pages dev` processes on one shared local D1 (temporary `wrangler.toml`/`.dev.vars`, deleted after), a hand-minted `ck_session` cookie. Create/list/revoke via curl (401 without a cookie, 403 for `sales`), the public flow (see altaventureswebsite §74.4), then staff fulfill/decline of the requests the links created. A Playwright pass over the new card: generate, copy (clipboard holds the exact URL), revoke, and used links showing their addresses; no page errors.
