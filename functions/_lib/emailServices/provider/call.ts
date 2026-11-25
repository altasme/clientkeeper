// Wraps every provider call with a timeout and exception normalization, so
// an adapter bug or a hung connection can never escape as a thrown error
// or hang a request forever.
//
// A timeout or an unexpected exception is reported as outcome 'unknown',
// never 'not_performed': we cannot prove the provider didn't act on the
// request, so the engine must keep any reserved slot held rather than
// release it and risk a second, duplicate mailbox.

import type { ProviderResult } from "./types";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

export interface TimedResult<T> {
  result: ProviderResult<T>;
  durationMs: number;
}

export async function callProvider<T>(fn: () => Promise<ProviderResult<T>>, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS): Promise<TimedResult<T>> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderResult<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error: { code: "timeout", message: `Provider did not respond within ${Math.round(timeoutMs / 1000)}s.`, outcome: "unknown", retryable: false },
        }),
      timeoutMs
    );
  });

  let result: ProviderResult<T>;
  try {
    result = await Promise.race([fn(), timeout]);
  } catch (err) {
    // Message only, never the error object: an adapter exception could
    // carry request details.
    const message = err instanceof Error ? err.message : "Unexpected provider adapter error.";
    result = { ok: false, error: { code: "provider_error", message: `Provider adapter error: ${message}`.slice(0, 300), outcome: "unknown", retryable: false } };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { result, durationMs: Date.now() - started };
}
