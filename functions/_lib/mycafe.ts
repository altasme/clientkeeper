// Talks to the MyCafe POS control-plane Worker's admin API
// (mycafe-pos-system/control-plane/src/index.ts) to provision a cafe or mint
// a device activation token for a `clients` row with `product = 'mycafe_pos'`
// (see CLAUDE.md's MyCafe section). Same "duplicate the pattern, not the
// code" convention as every other cross-repo shared concept in this
// codebase (functions/_lib/email.ts etc.) — MyCafe POS is a separate
// product with its own repo/deploy, this is just the one place this app
// calls out to it.
//
// MYCAFE_ADMIN_API_TOKEN is the SAME bearer token MyCafe's own control-plane
// /admin/* routes require everywhere else (its ADMIN_API_TOKEN secret) — set
// it here as a Cloudflare Pages environment variable/secret, never
// committed, same discipline as RESEND_API_KEY/WORKOS_API_KEY.

export interface MyCafeEnv {
  MYCAFE_ADMIN_API_TOKEN: string;
  MYCAFE_CONTROL_PLANE_URL: string;
}

export class MyCafeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ProvisionResult {
  cafeId: string;
  status: "active" | "provisioning";
  deviceActivationToken?: string;
  error?: string;
}

// Creates a brand-new cafe (first call for this client) or resumes a
// partially-provisioned one (mycafeCafeId already on file — provisioning is
// idempotent/resumable on MyCafe's side, see its BACKEND.md). A resume never
// returns a fresh deviceActivationToken (that step already ran) — call
// mintMyCafeDevice separately if the client needs a new one.
export async function provisionMyCafeCafe(
  env: MyCafeEnv,
  input: {
    mycafeCafeId: string | null;
    slug: string;
    businessName: string;
    storeName: string;
    ownerEmail: string;
    ownerName: string;
  },
): Promise<ProvisionResult> {
  const url = input.mycafeCafeId
    ? `${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes/${input.mycafeCafeId}/provision`
    : `${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: input.mycafeCafeId
      ? undefined
      : JSON.stringify({
          slug: input.slug,
          businessName: input.businessName,
          storeName: input.storeName,
          ownerEmail: input.ownerEmail,
          ownerName: input.ownerName,
        }),
  });

  const body = (await response.json().catch(() => null)) as ProvisionResult | null;
  if (!response.ok || !body) {
    throw new MyCafeApiError(response.status, body?.error || `MyCafe provisioning failed: ${response.status}`);
  }
  return body;
}

// Mints an additional device activation token for an already-active cafe —
// the plaintext token is only ever returned once by MyCafe's API and never
// stored there, same rule applies here: display it to staff once, never
// persist it in this app's own database either.
export async function mintMyCafeDevice(env: MyCafeEnv, mycafeCafeId: string): Promise<string> {
  const response = await fetch(`${env.MYCAFE_CONTROL_PLANE_URL}/admin/cafes/${mycafeCafeId}/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MYCAFE_ADMIN_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deviceName: "ClientKeeper-issued device" }),
  });
  const body = (await response.json().catch(() => null)) as { deviceActivationToken?: string; error?: string } | null;
  if (!response.ok || !body?.deviceActivationToken) {
    throw new MyCafeApiError(response.status, body?.error || `Minting a device token failed: ${response.status}`);
  }
  return body.deviceActivationToken;
}
