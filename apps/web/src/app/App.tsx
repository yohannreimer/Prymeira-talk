import { AgentsPage } from "../features/assistant/AgentsPage";
import { AutomationsPage } from "../features/automations/AutomationsPage";
import { CampaignsPage } from "../features/campaigns/CampaignsPage";
import { ChannelsPage } from "../features/channels/ChannelsPage";
import { ContactsPage } from "../features/contacts/ContactsPage";
import { CrmPage } from "../features/crm/CrmPage";
import { InboxPage } from "../features/inbox/InboxPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TalkSuiteShell } from "../features/shell/TalkSuiteShell";
import type { TalkModuleKey } from "../features/shell/moduleRegistry";
import { TeamPage } from "../features/team/TeamPage";
import { AuthGate } from "./auth";

function renderModule(moduleKey: TalkModuleKey) {
  switch (moduleKey) {
    case "atendimento":
      return <InboxPage />;
    case "contatos":
      return <ContactsPage />;
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
  return (
    <AuthGate>
      <TalkSuiteShell renderModule={renderModule} />
    </AuthGate>
  );
}
