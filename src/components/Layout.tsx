import { useState } from "react";
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

// [2026-10-30] Responsive shell, per the operator's direct request to
// make the whole app mobile responsive. The sidebar used to be a fixed
// 240px column with no way to hide it -- on a phone that left barely
// any room for the actual content next to it, and there was no
// hamburger/drawer mechanism at all to get it out of the way. Below
// `md:`, the sidebar becomes a slide-in drawer (off-canvas by default,
// `translate-x-0` when open) behind a backdrop, triggered by a small
// sticky top bar that only renders on mobile; at `md:` and up, it
// reverts to the original always-visible static column, byte-for-byte
// the same classes as before this change.
function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return `block rounded-lg px-3 py-2 text-sm font-medium transition ${
    isActive ? "bg-brand-blue text-white" : "text-ink/70 hover:bg-paper-alt hover:text-ink"
  }`;
}

export default function Layout() {
  const { staffUser } = useMe();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    window.location.href = "/api/auth-start";
  };

  const closeMobileNav = () => setMobileNavOpen(false);

  return (
    <div className="flex min-h-screen flex-col bg-paper-alt md:flex-row">
      {/* Sticky mobile-only top bar: logo + hamburger. Normal document
          flow (not fixed), so it simply pushes <main> down -- no manual
          height offset math needed anywhere else. */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-ink/10 bg-white px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <img src="/images/brand/altaventures-logo.png" alt="Altaventures" width={838} height={105} className="h-5 w-auto" />
          <span className="text-sm font-bold text-brand-navy">ClientKeeper</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileNavOpen}
          className="rounded-lg border border-ink/15 p-2 text-ink/70 hover:bg-paper-alt"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>

      {/* Backdrop, mobile only, shown only while the drawer is open. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={closeMobileNav} aria-hidden="true" />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 -translate-x-full transform flex-col border-r border-ink/10 bg-white transition-transform duration-200 md:static md:z-auto md:w-60 md:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : ""
        }`}
      >
        <div className="flex items-center justify-between border-b border-ink/10 px-5 py-5">
          <div>
            <img src="/images/brand/altaventures-logo.png" alt="Altaventures" width={838} height={105} className="h-6 w-auto" />
            <h1 className="mt-2 text-lg font-bold text-brand-navy">ClientKeeper</h1>
          </div>
          <button
            type="button"
            onClick={closeMobileNav}
            aria-label="Close navigation menu"
            className="rounded-lg p-1 text-ink/40 hover:bg-paper-alt hover:text-ink md:hidden"
          >
            &times;
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} onClick={closeMobileNav} className={navLinkClassName}>
              {item.label}
            </NavLink>
          ))}
          <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink/30">Products</p>
          {PRODUCT_NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} onClick={closeMobileNav} className={navLinkClassName}>
              {item.label}
            </NavLink>
          ))}
          <div className="pt-4">
            <NavLink to={SETTINGS_NAV_ITEM.to} onClick={closeMobileNav} className={navLinkClassName}>
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
      <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 sm:px-6 md:px-8 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}
