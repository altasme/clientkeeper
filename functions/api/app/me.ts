// Cloudflare Pages Function: GET /api/app/me
//
// The authenticated staff member's own identity, as resolved by
// functions/api/app/_middleware.ts. The frontend's MeContext uses this to
// know who's logged in and what nav/actions their role permits.

import type { StaffUser } from "../../_lib/roles";

export const onRequestGet: PagesFunction<unknown, string, { staffUser: StaffUser }> = async ({ data }) => {
  return new Response(JSON.stringify({ staffUser: data.staffUser }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
