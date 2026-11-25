// Maps provisioning outcomes to HTTP responses so the create and retry
// routes answer identically. See mailboxes/index.ts for the status codes.

import type { EngineResult, ProvisionOutcome } from "./engine";
import type { ProviderError } from "./provider";
import { json } from "./http";

export function providerFailureStatus(error: ProviderError): number {
  if (error.outcome === "unknown") return 202;
  if (error.code === "not_configured") return 503;
  return 502;
}

export function provisionResponse(result: EngineResult<ProvisionOutcome>): Response {
  if (!result.ok) return json(result.status, { error: result.error, code: result.code, ...result.details });
  const { mailbox, duplicateRequest, providerError } = result.value;
  if (duplicateRequest) return json(200, { mailbox, duplicateRequest: true });
  if (!providerError) return json(201, { mailbox });
  if (mailbox.status === "needs_review") {
    return json(202, { mailbox, code: providerError.code, error: `The provider's response was ${providerError.code === "duplicate" ? "that this mailbox already exists" : "unclear"}. The slot is held until someone resolves it.`, providerError: providerError.message });
  }
  return json(providerFailureStatus(providerError), { error: providerError.message, code: providerError.code, mailbox });
}
