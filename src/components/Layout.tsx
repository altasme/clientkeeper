import { NavLink, Outlet } from "react-router-dom";
import { useMe } from "../lib/MeContext";
import { logout } from "../lib/api";

// Web development is this app's original, and still primary, funnel — the
// nav items above reflect its stage machine. MyCafe POS is a second, later,
// unrelated product line (a SaaS product, not a services funnel), so it's
// grouped as its own section below rather than interleaved as one more step
// in the web_dev flow.
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
];

const PRODUCT_NAV_ITEMS = [{ label: "MyCafe POS", to: "/mycafe" }];

const SETTINGS_NAV_ITEM = { label: "Settings", to: "/settings" };

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
          <img src="/images/brand/altaventures-logo.png" alt="Altaventures" width={838} height={105} className="h-6 w-auto" />
          <h1 className="mt-2 text-lg font-bold text-brand-navy">ClientKeeper</h1>
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
          <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink/30">Products</p>
          {PRODUCT_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? "bg-brand-blue text-white" : "text-ink/70 hover:bg-paper-alt hover:text-ink"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          <div className="pt-4">
            <NavLink
              to={SETTINGS_NAV_ITEM.to}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? "bg-brand-blue text-white" : "text-ink/70 hover:bg-paper-alt hover:text-ink"
                }`
              }
            >
              {SETTINGS_NAV_ITEM.label}
            </NavLink>
          </div>
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
