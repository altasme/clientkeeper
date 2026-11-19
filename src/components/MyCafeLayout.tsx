import { Link, NavLink, Outlet } from "react-router-dom";
import { useMe } from "../lib/MeContext";

// MyCafe POS is its own product with its own workspace inside ClientKeeper: a
// separate shell (own header, own navigation, own accent) rather than one more
// page in the web-development CRM's sidebar. Mobile first: a compact header and a
// horizontally scrollable tab bar on phones; a left rail from `md:` up.
const TABS = [
  { label: "Overview", to: "/mycafe", end: true },
  { label: "Cafés", to: "/mycafe/cafes", end: false },
  { label: "Announcements", to: "/mycafe/announcements", end: false },
];

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition md:block md:rounded-lg md:px-3 ${
    isActive ? "bg-mycafe text-white" : "text-ink/70 hover:bg-mycafe-soft hover:text-mycafe-dark"
  }`;

function CupMark() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 8h1a4 4 0 0 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <path d="M6 2v3M10 2v3M14 2v3" />
    </svg>
  );
}

export default function MyCafeLayout() {
  const { staffUser } = useMe();
  return (
    <div className="min-h-screen bg-mycafe-soft/40">
      <header className="sticky top-0 z-30 bg-mycafe-dark text-white shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/15">
              <CupMark />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight sm:text-base">MyCafe POS</p>
              <p className="truncate text-[11px] leading-tight text-white/60">Managed in ClientKeeper</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden max-w-[10rem] truncate text-xs text-white/70 sm:block">{staffUser.full_name || staffUser.email}</span>
            <Link
              to="/"
              className="rounded-full border border-white/30 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
            >
              &larr; ClientKeeper
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 md:flex-row md:gap-8 md:py-8">
        {/* Phones: a scrollable pill row that bleeds to the screen edges. md+: a rail. */}
        <nav aria-label="MyCafe sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:gap-1 md:overflow-visible md:px-0">
          {TABS.map((tab) => (
            <NavLink key={tab.to} to={tab.to} end={tab.end} className={tabClass}>
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
