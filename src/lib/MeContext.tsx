import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { fetchMe, type MeResponse } from "./api";

interface MeContextValue {
  staffUser: MeResponse["staffUser"];
  refresh: () => void;
}

const MeContext = createContext<MeContextValue | null>(null);

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used within MeProvider");
  return ctx;
}

type AuthErrorCode = "auth_failed" | "not_staff";

const AUTH_ERROR_COPY: Record<AuthErrorCode, { headline: string; body: string }> = {
  not_staff: {
    headline: "No staff account configured",
    body: "You signed in successfully, but there's no ClientKeeper role set up for this account yet. Ask an admin to add you to the users table with your WorkOS user id.",
  },
  auth_failed: {
    headline: "Something went wrong signing you in",
    body: "Please try again.",
  },
};

function AuthErrorScreen({ code }: { code: AuthErrorCode }) {
  const copy = AUTH_ERROR_COPY[code];

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm rounded-2xl border border-ink/10 bg-white p-6 text-center sm:p-8">
        <p className="text-sm font-semibold text-brand-blue">Sign-In Problem</p>
        <h1 className="mt-1 text-xl font-bold text-brand-navy">{copy.headline}</h1>
        <p className="mt-2 text-sm text-ink/60">{copy.body}</p>
        {code === "auth_failed" && (
          <button
            type="button"
            onClick={() => {
              window.location.href = "/api/auth-start";
            }}
            className="mt-5 inline-flex items-center justify-center rounded-full bg-brand-blue px-6 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#0b57cc]"
          >
            Try Again
          </button>
        )}
      </div>
    </div>
  );
}

function readAuthErrorFromUrl(): AuthErrorCode | null {
  const value = new URLSearchParams(window.location.search).get("error");
  return value === "auth_failed" || value === "not_staff" ? value : null;
}

export function MeProvider({ children }: { children: ReactNode }) {
  const [staffUser, setStaffUser] = useState<MeResponse["staffUser"] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // Read once — a hard redirect is the only way the URL changes here
  // (see below), so this never needs to be reactive.
  const [authError] = useState<AuthErrorCode | null>(() => readAuthErrorFromUrl());
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // If auth-callback already told us what went wrong (e.g. a real WorkOS
    // login with no matching `users` row), show that instead of blindly
    // redirecting into another login attempt — a silent redirect loop is
    // exactly the bug this same pattern fixed once already in the sibling
    // clienthub app.
    if (authError) return;

    let cancelled = false;
    setStatus("loading");
    fetchMe()
      .then((result) => {
        if (cancelled) return;
        if (result === "unauthenticated") {
          window.location.href = "/api/auth-start";
          return;
        }
        if (result === "not_staff") {
          // A session that was valid when issued but whose `users` row has
          // since been removed (a departed staff member) lands here too —
          // never redirect back into login for this, since logging in
          // again wouldn't fix a revoked role and would just loop.
          window.location.href = "/?error=not_staff";
          return;
        }
        setStaffUser(result.staffUser);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, authError]);

  if (authError) {
    return <AuthErrorScreen code={authError} />;
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-ink/50">Loading&hellip;</p>
      </div>
    );
  }

  if (status === "error" || !staffUser) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <p className="text-sm text-ink/60">We couldn't load your account right now. Please refresh the page.</p>
      </div>
    );
  }

  return <MeContext.Provider value={{ staffUser, refresh }}>{children}</MeContext.Provider>;
}
