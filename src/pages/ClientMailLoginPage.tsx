// /mail/client-login -- a client signs in to their own hosted mailbox with
// its email address and real password (CLAUDE.md §36). Rendered OUTSIDE
// MeProvider (see App.tsx): a client has no staff account, so the staff
// auth bootstrap (which redirects to WorkOS) must never run here.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { clientMailApi } from "../lib/clientMailApi";

export default function ClientMailLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in -> straight to the mailbox.
  useEffect(() => {
    clientMailApi
      .me()
      .then((m) => m && navigate("/mail/client", { replace: true }))
      .catch(() => undefined);
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await clientMailApi.login(email.trim(), password);
      setPassword("");
      navigate("/mail/client", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We couldn't reach the server. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-alt px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-ink/10 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold text-brand-blue">Altaventures Mail</p>
        <h1 className="mt-1 text-xl font-bold text-brand-navy">Sign in to your mailbox</h1>
        <p className="mt-2 text-sm text-ink/60">Use your email address and the same password you use for this mailbox in other email apps.</p>
        <label className="mt-6 block text-sm font-semibold text-ink/80" htmlFor="cm-email">
          Email address
        </label>
        <input
          id="cm-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue"
        />
        <label className="mt-4 block text-sm font-semibold text-ink/80" htmlFor="cm-password">
          Password
        </label>
        <input
          id="cm-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm outline-none focus:border-brand-blue"
        />
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="mt-6 w-full rounded-full bg-brand-blue px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
