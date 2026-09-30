import { AgentsPage } from "../features/assistant/AgentsPage";
import { AutomationsPage } from "../features/automations/AutomationsPage";
import { CampaignsPage } from "../features/campaigns/CampaignsPage";
import { ChannelsPage } from "../features/channels/ChannelsPage";
import { ContactsPage } from "../features/contacts/ContactsPage";
import { CrmPage } from "../features/crm/CrmPage";
import { InboxPage } from "../features/inbox/InboxPage";
import { FollowupsPage } from "../features/followups/FollowupsPage";
import { LeadsPage } from "../features/leads/LeadsPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TalkSuiteShell } from "../features/shell/TalkSuiteShell";
import type { TalkModuleKey } from "../features/shell/moduleRegistry";
import { TeamPage } from "../features/team/TeamPage";
import { AuthGate } from "./auth";
import { useEffect, useState } from "react";
import { SupervisionPage } from "../features/supervision/SupervisionPage";

function isSupervisionRoute() {
  return new URLSearchParams(window.location.search).get("module") === "supervisao";
}

function renderModule(moduleKey: TalkModuleKey) {
  switch (moduleKey) {
    case "atendimento":
      return <InboxPage />;
    case "followups":
      return <FollowupsPage />;
    case "contatos":
      return <ContactsPage />;
    case "leads":
      return <LeadsPage />;
    case "canais":
      return <ChannelsPage />;
    case "automacoes":
      return <AutomationsPage />;
    case "disparos":
      return <CampaignsPage />;
    case "relatorios":
      return <ReportsPage />;
    case "equipe":
      return <TeamPage />;
    case "ia":
      return <AgentsPage />;
    case "atomic_crm":
      return <CrmPage />;
    case "ajustes":
      return <SettingsPage />;
  }
}

export function App() {
  const [supervision, setSupervision] = useState(isSupervisionRoute);
  useEffect(() => {
    const update = () => setSupervision(isSupervisionRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return (
    <AuthGate>
      {supervision ? <SupervisionPage /> : <TalkSuiteShell renderModule={renderModule} />}
    </AuthGate>
  );
}
