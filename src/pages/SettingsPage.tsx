import { useMe } from "../lib/MeContext";

export default function SettingsPage() {
  const { staffUser } = useMe();

  return (
    <div>
      <h1 className="text-2xl font-bold text-brand-navy">Settings</h1>

      <div className="mt-6 max-w-md rounded-xl border border-ink/10 bg-white p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Your Account</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink/50">Name</dt>
            <dd>{staffUser.full_name || "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink/50">Email</dt>
            <dd>{staffUser.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink/50">Role</dt>
            <dd className="capitalize">{staffUser.role}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 max-w-md rounded-xl border border-ink/10 bg-white p-5 text-sm text-ink/60">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Adding Staff</h2>
        <p className="mt-2">
          There's no self-service "add a staff member" flow in V1. To add someone: invite them via WorkOS (the clienthub
          invitation flow, or directly in the WorkOS dashboard), have them sign in once here, confirm their WorkOS user id,
          then insert a row into the shared <code className="rounded bg-paper-alt px-1 py-0.5">users</code> table with their
          role (owner, developer, admin, or sales).
        </p>
      </div>
    </div>
  );
}
