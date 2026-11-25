// Provider registry: the single place that decides which adapter serves a
// given provider name. Today every provider resolves to the honest
// NotConfiguredProvider placeholder (see notConfigured.ts). When a real
// Z.com adapter exists, return it here (and only when its credentials are
// actually present in env), e.g.
//   if (name === "zcom" && env.ZCOM_API_TOKEN) return new ZcomProvider(env);
// Credentials must come from Pages secrets only; never from the database
// and never from a request.

import { NotConfiguredProvider } from "./notConfigured";
import type { EmailHostingProvider, ProviderName } from "./types";

// Deliberately empty for now: no provider secrets exist yet. Add the real
// adapter's secret names here when it is built.
export type ProviderEnv = Record<string, never>;

export function getEmailProvider(name: ProviderName, _env?: ProviderEnv): EmailHostingProvider {
  return new NotConfiguredProvider(name);
}

export function isProviderName(value: unknown): value is ProviderName {
  return value === "zcom";
}

export * from "./types";
export { PROVIDER_NOT_CONFIGURED_MESSAGE, providerDisplayName } from "./notConfigured";
export { callProvider } from "./call";
