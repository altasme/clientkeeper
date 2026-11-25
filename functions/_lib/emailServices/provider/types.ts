// Generic email-hosting provider interface (CLAUDE.md §34).
//
// Every operation that would touch a real hosting provider (Z.com first)
// goes through this interface, and ONLY through it. Nothing outside the
// provider/ folder may know a provider's request/response format: adapters
// translate to and from the normalized shapes below.
//
// Results are values, not exceptions. Every failure carries:
//   - code: a normalized category the engine branches on;
//   - outcome: 'not_performed' (the provider definitely did NOT apply the
//     change, so a reserved mailbox slot can be released) or 'unknown'
//     (the request may have been applied, e.g. a timeout after sending, so
//     the slot must stay held until a human or a sync resolves it);
//   - retryable: whether repeating the same call is safe and may succeed.
//
// Adapters must never put a password, API token, or raw request body in
// any message, detail or log they return.

export type ProviderName = "zcom";

// How new mail for a provider-hosted mailbox will reach ClientKeeper's own
// webmail once the bridge is built (not built yet). Matches
// email_mailboxes.inbound_source.
export type InboundSource = "cloudflare_email_routing" | "zcom_poll_sync";

export const PROVIDER_INBOUND_SOURCE: Record<ProviderName, InboundSource> = {
  zcom: "zcom_poll_sync",
};

export type ProviderErrorCode =
  | "not_configured" // no adapter/credentials: nothing was attempted
  | "not_supported" // this provider/adapter cannot do the operation at all
  | "auth_failed" // the provider rejected our credentials
  | "rate_limited"
  | "timeout"
  | "unavailable" // provider down / 5xx
  | "duplicate" // the mailbox/domain already exists at the provider
  | "invalid_input" // bad username/password/domain per provider rules
  | "not_found" // domain/service/mailbox does not exist at the provider
  | "quota_exceeded" // provider-side limit, independent of our entitlement
  | "provider_error"; // anything else the adapter could not classify

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  outcome: "not_performed" | "unknown";
  retryable: boolean;
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export interface ProviderStatus {
  configured: boolean;
  displayName: string;
  message: string;
}

export interface ProviderServiceRef {
  providerServiceId: string | null;
}

export interface ProviderDomain {
  providerDomainId: string;
  domain: string;
}

export interface ProviderMailbox {
  // The provider's own opaque ids (Z.com: service_id + email_id). Stored on
  // the mailbox row for the future webmail bridge; never assumed to be UUIDs.
  providerServiceId: string | null;
  providerMailboxId: string;
  address: string;
  status: "active" | "suspended" | "unknown";
  storageUsedMb: number | null;
  storageQuotaMb: number | null;
}

export interface ProviderServiceDetails {
  providerServiceId: string;
  status: string;
  domains: ProviderDomain[];
}

export interface ProviderUsage {
  storageUsedMb: number | null;
  mailboxCount: number | null;
}

export interface CreateMailboxInput extends ProviderServiceRef {
  domain: string;
  providerDomainId: string | null;
  localPart: string;
  address: string;
  // Passed straight through to the provider; never stored or logged.
  password: string;
  storageQuotaMb: number | null;
  // Stable per logical request, so an adapter whose provider supports it
  // can make retries idempotent on the provider side too.
  idempotencyKey: string;
}

export interface MailboxRef extends ProviderServiceRef {
  address: string;
  providerMailboxId: string | null;
}

export interface EmailHostingProvider {
  readonly name: ProviderName;
  status(): ProviderStatus;
  listDomains(ref: ProviderServiceRef): Promise<ProviderResult<ProviderDomain[]>>;
  listMailboxes(ref: ProviderServiceRef & { domain: string; providerDomainId: string | null }): Promise<ProviderResult<ProviderMailbox[]>>;
  getMailboxDetails(ref: MailboxRef): Promise<ProviderResult<ProviderMailbox>>;
  createMailbox(input: CreateMailboxInput): Promise<ProviderResult<ProviderMailbox>>;
  deleteMailbox(ref: MailboxRef): Promise<ProviderResult<{ deleted: true }>>;
  changeMailboxPassword(ref: MailboxRef & { password: string }): Promise<ProviderResult<{ changed: true }>>;
  configureForwarding(ref: MailboxRef & { forwardTo: string[]; keepCopy: boolean }): Promise<ProviderResult<{ configured: true }>>;
  getServiceDetails(ref: ProviderServiceRef): Promise<ProviderResult<ProviderServiceDetails>>;
  getUsage(ref: ProviderServiceRef): Promise<ProviderResult<ProviderUsage>>;
}
