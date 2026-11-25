// ============================================================================
//  NOT A WORKING INTEGRATION.  THIS ADAPTER NEVER TALKS TO ANY PROVIDER.
// ============================================================================
//
// Placeholder for the Z.com adapter. No Z.com API documentation or
// credentials exist yet (CLAUDE.md §34), so nothing about Z.com's real
// endpoints, auth scheme, payloads or capabilities is known, and none of it
// is guessed here.
//
// Every operation returns a `not_configured` failure with
// outcome 'not_performed' (we provably did nothing, so the engine releases
// any reserved slot) and retryable false. It never returns success, never
// fabricates an id, and never pretends a mailbox exists. A mailbox can only
// become 'active' once a real adapter replaces this one.
//
// To add the real integration: write provider/zcom.ts implementing
// EmailHostingProvider against the real documentation, and return it from
// getEmailProvider() in provider/index.ts when its credentials are present.
// Nothing outside provider/ needs to change.

import type { EmailHostingProvider, ProviderError, ProviderName, ProviderResult, ProviderStatus } from "./types";

export const PROVIDER_NOT_CONFIGURED_MESSAGE =
  "Email provider not configured: the Z.com integration has not been built yet (no API credentials or documentation). Nothing was sent to any provider.";

export class NotConfiguredProvider implements EmailHostingProvider {
  // Lets anything that holds a provider check, without guessing from
  // results, that it is the placeholder.
  readonly isPlaceholder = true as const;

  constructor(readonly name: ProviderName) {}

  status(): ProviderStatus {
    return { configured: false, displayName: providerDisplayName(this.name), message: PROVIDER_NOT_CONFIGURED_MESSAGE };
  }

  private fail<T>(): Promise<ProviderResult<T>> {
    const error: ProviderError = {
      code: "not_configured",
      message: PROVIDER_NOT_CONFIGURED_MESSAGE,
      outcome: "not_performed",
      retryable: false,
    };
    return Promise.resolve({ ok: false, error });
  }

  listDomains() {
    return this.fail<never>();
  }
  listMailboxes() {
    return this.fail<never>();
  }
  getMailboxDetails() {
    return this.fail<never>();
  }
  createMailbox() {
    return this.fail<never>();
  }
  deleteMailbox() {
    return this.fail<never>();
  }
  changeMailboxPassword() {
    return this.fail<never>();
  }
  configureForwarding() {
    return this.fail<never>();
  }
  getServiceDetails() {
    return this.fail<never>();
  }
  getUsage() {
    return this.fail<never>();
  }
}

export function providerDisplayName(name: ProviderName): string {
  switch (name) {
    case "zcom":
      return "Z.com";
  }
}
