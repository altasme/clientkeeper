// /mail/client -- a client's own mailbox (CLAUDE.md §36). Rendered OUTSIDE
// MeProvider (no staff auth bootstrap) and talks ONLY to /api/mail-client
// through lib/clientMailApi.ts.
//
// The workspace itself (folders, list, thread, composer) lives in
// components/mail/OwnerMailWorkspace.tsx, shared with /mail/connect
// (CLAUDE.md §38); this page only resolves the signed-in mailbox and hands
// the workspace clientMailApi.
//
// Deliberately absent (server has no such routes for mailbox owners):
// drafts/autosave, attachment upload, labels, settings, signatures editing,
// permanent delete. A forward doesn't carry the original's attachments.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { clientMailApi, type ClientMailbox } from "../lib/clientMailApi";
import OwnerMailWorkspace from "../components/mail/OwnerMailWorkspace";

export default function ClientMailPage() {
  const navigate = useNavigate();
  const [mailbox, setMailbox] = useState<ClientMailbox | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const toLogin = useCallback(() => navigate("/mail/client-login", { replace: true }), [navigate]);
  const handleAuth = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        toLogin();
        return true;
      }
      return false;
    },
    [toLogin]
  );

  useEffect(() => {
    clientMailApi
      .me()
      .then((m) => (m ? setMailbox(m) : toLogin()))
      .catch(() => setBootError("Couldn't load your mailbox."));
  }, [toLogin]);

  const signOut = async () => {
    await clientMailApi.logout().catch(() => undefined);
    toLogin();
  };

  if (!mailbox) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink/50">{bootError ?? "Loading…"}</div>;
  }

  // A mailbox owner can always move their own mail to Trash.
  return <OwnerMailWorkspace api={clientMailApi} mailbox={{ ...mailbox, canDelete: true }} onSignOut={signOut} onAuthError={handleAuth} />;
}
