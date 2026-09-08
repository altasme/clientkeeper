import { NavLink, Outlet } from "react-router-dom";
import { useMe } from "../lib/MeContext";
import { logout } from "../lib/api";

const NAV_ITEMS = [
  { label: "Dashboard", to: "/" },
  { label: "Leads", to: "/leads" },
  { label: "Clients", to: "/clients" },
  { label: "Projects", to: "/projects" },
  { label: "Discovery", to: "/discovery" },
  { label: "Presentations", to: "/presentations" },
  { label: "Offers", to: "/offers" },
  { label: "Billing", to: "/billing" },
  { label: "Payments", to: "/payments" },
  { label: "Settings", to: "/settings" },
];

export default function Layout() {
  const { staffUser } = useMe();

  const handleLogout = async () => {
    await logout();
    window.location.href = "/api/auth-start";
  };

  return (
    <div className="flex min-h-screen bg-paper-alt">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink/10 bg-white">
        <div className="border-b border-ink/10 px-5 py-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Altaventures</p>
          <h1 className="mt-0.5 text-lg font-bold text-brand-navy">ClientKeeper</h1>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? "bg-brand-blue text-white" : "text-ink/70 hover:bg-paper-alt hover:text-ink"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-ink/10 px-4 py-4">
          <p className="truncate text-sm font-semibold text-ink">{staffUser.full_name || staffUser.email}</p>
          <p className="text-xs capitalize text-ink/50">{staffUser.role}</p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-2 text-xs font-semibold text-brand-blue hover:underline"
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
