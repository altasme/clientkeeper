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

- [ ] Behind WorkOS AuthKit with D1-backed role checks on every endpoint.
- [ ] Dashboard, Leads, Clients, Projects, Discovery, Presentations, Offers, Payments, Settings nav sections built.
- [ ] Stage controls enforce the transition map; admin override requires a reason and writes `audit_log`.
- [ ] Commercial unlock endpoints stage-gate correctly; offer content is DB-configurable.
- [ ] "Paid, no account yet" list + resend-invite action work end to end.
- [ ] Every acceptance test in source spec §6 passes for this app's endpoints specifically (unauthenticated/wrong-role rejection, no client-writable path exists here by definition since there are no client-facing endpoints at all).

---

## 6. Guardrails

1. No public/anonymous endpoint of any kind — every route requires a valid staff session with a matching D1 role.
2. Never expose the full pricing table, only the currently-relevant offer.
3. Every sensitive action (override, unlock, invite reissue) is audited — no silent mutations.
4. Do not build the resource library before it's scheduled for V1.1.
5. Do not build real booking-system integration before its spec is supplied (see `clienthub/CLAUDE.md` §1.6) — this app's UI for discovery/presentation scheduling works against the interim call-request data only.
