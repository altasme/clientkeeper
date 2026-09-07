// Booking engine constants + conflict check, duplicated from clienthub's
// identical module rather than shared as a package (see this repo's
// CLAUDE.md §0 "reuse the pattern, not the code" convention). This app
// doesn't need the full slot-grid generator clienthub has — staff enter a
// presentation's date/time directly rather than picking from a generated
// grid — just the same conflict rule, so a presentation can't be
// double-booked against an existing discovery call or another
// presentation.
//
// See clienthub/functions/_lib/scheduling.ts for the full reasoning
// behind the 60-minute symmetric-conflict rule (45min session + 15min
// buffer, treated as one 60-minute reserved block per session).

export const SESSION_DURATION_MINUTES = 45;
export const BUFFER_MINUTES = 15;
export const SLOT_INTERVAL_MINUTES = SESSION_DURATION_MINUTES + BUFFER_MINUTES; // 60

const MINUTE_MS = 60 * 1000;

/** Two session start times (UTC ms) conflict iff less than 60 min apart. */
export function slotsConflict(aMs: number, bMs: number): boolean {
  return Math.abs(aMs - bMs) < SLOT_INTERVAL_MINUTES * MINUTE_MS;
}

/** true iff HH:MM is well-formed and 00:00–23:59. */
export function isValidHHMM(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}
