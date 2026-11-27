import { lazy, Suspense, type ReactNode } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { MeProvider } from "./lib/MeContext";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import LeadsPage from "./pages/LeadsPage";
import LeadDetailPage from "./pages/LeadDetailPage";
import ClientsPage from "./pages/ClientsPage";
import ClientDetailPage from "./pages/ClientDetailPage";
import ProjectsPage from "./pages/ProjectsPage";
import DiscoveryPage from "./pages/DiscoveryPage";
import PresentationsPage from "./pages/PresentationsPage";
import OffersPage from "./pages/OffersPage";
import BillingPage from "./pages/BillingPage";
import NewBillPage from "./pages/NewBillPage";
import BillDetailPage from "./pages/BillDetailPage";
import PaymentsPage from "./pages/PaymentsPage";
import SettingsPage from "./pages/SettingsPage";
import MyCafeLayout from "./components/MyCafeLayout";
import MyCafeOverviewPage from "./pages/MyCafeOverviewPage";
import MyCafeAnnouncementsPage from "./pages/MyCafeAnnouncementsPage";
import MyCafeAnnouncementEditorPage from "./pages/MyCafeAnnouncementEditorPage";
import MyCafePage from "./pages/MyCafePage";
import MyCafeClientDetailPage from "./pages/MyCafeClientDetailPage";
import ProposalEditorPage from "./pages/ProposalEditorPage";
import ServiceAgreementEditorPage from "./pages/ServiceAgreementEditorPage";
import QuestionnaireEditorPage from "./pages/QuestionnaireEditorPage";
import MailPage from "./pages/MailPage";
// Email Services pages are code-split: they're admin-only screens most
// sessions never open, and keeping them out of the main chunk keeps it
// under Vite's 500 kB warning.
const EmailServicesPage = lazy(() => import("./pages/EmailServicesPage"));
const EmailServiceDetailPage = lazy(() => import("./pages/EmailServiceDetailPage"));
const EmailPlansPage = lazy(() => import("./pages/EmailPlansPage"));
// [2026-11-26] A client's own mailbox (CLAUDE.md §36). Code-split, and
// mounted OUTSIDE MeProvider below: a client has no staff account, and
// MeProvider's bootstrap would redirect them to the staff WorkOS login.
const ClientMailLoginPage = lazy(() => import("./pages/ClientMailLoginPage"));
const ClientMailPage = lazy(() => import("./pages/ClientMailPage"));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p className="text-sm text-ink/40">Loading…</p>}>{children}</Suspense>;
}

function LegacyMyCafeClientRedirect() {
  const { id } = useParams();
  return <Navigate to={`/mycafe/cafes/${id}`} replace />;
}

function App() {
  return (
    <Routes>
      {/* Client mailbox pages: no staff session involved. They call only /api/mail-client/*. */}
      <Route path="/mail/client-login" element={<Lazy><ClientMailLoginPage /></Lazy>} />
      <Route path="/mail/client" element={<Lazy><ClientMailPage /></Lazy>} />
      <Route path="*" element={<StaffApp />} />
    </Routes>
  );
}

function StaffApp() {
  return (
    <MeProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientDetailPage />} />
          {/* [2026-10-15] Flat -- a proposal can belong to a client or a lead now (CLAUDE.md §25), so it's no longer nested under one parent's path. */}
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
          {/* [2026-10-30] Same flat shape, CLAUDE.md §29 -- a service agreement can belong to a client, a lead, or neither. */}
          <Route path="/service-agreements/:agreementId" element={<ServiceAgreementEditorPage />} />
          <Route path="/clients/:clientId/questionnaires/:questionnaireId" element={<QuestionnaireEditorPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/discovery" element={<DiscoveryPage />} />
          <Route path="/presentations" element={<PresentationsPage />} />
          <Route path="/offers" element={<OffersPage />} />
          {/* [2026-11-25] Client email hosting (plans, allowances, provisioning), CLAUDE.md §34. "plans" is matched before ":id". */}
          <Route path="/email-services" element={<Lazy><EmailServicesPage /></Lazy>} />
          <Route path="/email-services/plans" element={<Lazy><EmailPlansPage /></Lazy>} />
          <Route path="/email-services/:id" element={<Lazy><EmailServiceDetailPage /></Lazy>} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/billing/new" element={<NewBillPage />} />
          <Route path="/billing/:id" element={<BillDetailPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        {/* [2026-11-24] Webmail has its own full-screen workspace (three panes need the sidebar's width), CLAUDE.md §32. */}
        <Route path="/mail" element={<MailPage />} />
        {/* MyCafe POS has its own workspace (own shell, own navigation), separate from the web-development CRM above. */}
        <Route element={<MyCafeLayout />}>
          <Route path="/mycafe" element={<MyCafeOverviewPage />} />
          <Route path="/mycafe/cafes" element={<MyCafePage />} />
          <Route path="/mycafe/cafes/:id" element={<MyCafeClientDetailPage />} />
          <Route path="/mycafe/announcements" element={<MyCafeAnnouncementsPage />} />
          <Route path="/mycafe/announcements/new" element={<MyCafeAnnouncementEditorPage />} />
          <Route path="/mycafe/announcements/:id" element={<MyCafeAnnouncementEditorPage />} />
          {/* Old bookmark: /mycafe/<clientId> used to be the café detail page. */}
          <Route path="/mycafe/:id" element={<LegacyMyCafeClientRedirect />} />
        </Route>
      </Routes>
    </MeProvider>
  );
}

export default App;
