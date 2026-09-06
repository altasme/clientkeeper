import { Routes, Route } from "react-router-dom";
import { MeProvider } from "./lib/MeContext";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import LeadsPage from "./pages/LeadsPage";
import ClientsPage from "./pages/ClientsPage";
import ClientDetailPage from "./pages/ClientDetailPage";
import ProjectsPage from "./pages/ProjectsPage";
import DiscoveryPage from "./pages/DiscoveryPage";
import PresentationsPage from "./pages/PresentationsPage";
import OffersPage from "./pages/OffersPage";
import PaymentsPage from "./pages/PaymentsPage";
import SettingsPage from "./pages/SettingsPage";

function App() {
  return (
    <MeProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientDetailPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/discovery" element={<DiscoveryPage />} />
          <Route path="/presentations" element={<PresentationsPage />} />
          <Route path="/offers" element={<OffersPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </MeProvider>
  );
}

export default App;
