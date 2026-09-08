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

**Plan override** (`Plan` card, new): displays the client's current active plan/add-ons (`GET /api/app/clients/:id` now also returns `subscriptions`, active rows only, same shape as clienthub's `/api/client/me`) plus a dropdown (`PLAN_OPTIONS`, display-only ids/names matching `functions/_lib/pricing.ts`'s `PLAN_CATALOG`) and a "Set Plan" button. `POST /api/app/clients/:id/set-plan` (`functions/api/app/clients/[id]/set-plan.ts`) supersedes the client's current active plan (`status = 'cancelled'`, `ended_at = now`) and inserts a new active row — same shape and same supersede semantics as clienthub's internal-upsell webhook, computing `renewal_amount_php`/`next_renewal_date` from the same catalog logic (`addInterval`). The critical difference: **this creates no payment and calls no ganap.net endpoint** — `payment_id` stays `NULL` on the new row, marking it staff-set rather than client-paid, purely for corrections/comps/data-entry fixes (e.g. a client who should have started on a different plan than the automatic Starter-Plan-on-signup default clienthub's ganap webhook now applies). Audited like every other sensitive admin action here (guardrail #3): writes both `audit_log` (`action: 'plan_override'`, before/after plan ids) and `client_activity` (visible in the Activity tab).

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
