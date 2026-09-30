import { ModuleErrorBoundary } from '../features/shell/ModuleErrorBoundary';
import { lazy, Suspense, useEffect, useState } from 'react';
import { TalkSuiteShell } from '../features/shell/TalkSuiteShell';
import type { TalkModuleKey } from '../features/shell/moduleRegistry';
import { AuthGate } from './auth';
import { TalkSessionProvider } from './session/TalkSessionProvider';
const moduleLoaders = {
  atendimento: () => import('../features/inbox/InboxPage').then(module => ({ default: module.InboxPage })),
  followups: () => import('../features/followups/FollowupsPage').then(module => ({ default: module.FollowupsPage })),
  contatos: () => import('../features/contacts/ContactsPage').then(module => ({ default: module.ContactsPage })),
  leads: () => import('../features/leads/LeadsPage').then(module => ({ default: module.LeadsPage })),
  canais: () => import('../features/channels/ChannelsPage').then(module => ({ default: module.ChannelsPage })),
  automacoes: () => import('../features/automations/AutomationsPage').then(module => ({ default: module.AutomationsPage })),
  disparos: () => import('../features/campaigns/CampaignsPage').then(module => ({ default: module.CampaignsPage })),
  relatorios: () => import('../features/reports/ReportsPage').then(module => ({ default: module.ReportsPage })),
  equipe: () => import('../features/team/TeamPage').then(module => ({ default: module.TeamPage })),
  ia: () => import('../features/assistant/AgentsPage').then(module => ({ default: module.AgentsPage })),
  atomic_crm: () => import('../features/crm/CrmPage').then(module => ({ default: module.CrmPage })),
  ajustes: () => import('../features/settings/SettingsPage').then(module => ({ default: module.SettingsPage })),
};
const modules = {
  atendimento: lazy(moduleLoaders.atendimento),
  followups: lazy(moduleLoaders.followups),
  contatos: lazy(moduleLoaders.contatos),
  leads: lazy(moduleLoaders.leads),
  canais: lazy(moduleLoaders.canais),
  automacoes: lazy(moduleLoaders.automacoes),
  disparos: lazy(moduleLoaders.disparos),
  relatorios: lazy(moduleLoaders.relatorios),
  equipe: lazy(moduleLoaders.equipe),
  ia: lazy(moduleLoaders.ia),
  atomic_crm: lazy(moduleLoaders.atomic_crm),
  ajustes: lazy(moduleLoaders.ajustes),
};
const SupervisionPage = lazy(() => import('../features/supervision/SupervisionPage').then(module => ({ default: module.SupervisionPage })));
function isSupervisionRoute() {
  return new URLSearchParams(window.location.search).get("module") === "supervisao";
}

function renderModule(moduleKey: TalkModuleKey) {
  const Module = modules[moduleKey];
  return <ModuleErrorBoundary key={moduleKey}><Suspense fallback={<div className="center-state" role="status">Carregando módulo…</div>}><Module /></Suspense></ModuleErrorBoundary>;
}
function prefetchModule(moduleKey: TalkModuleKey) { void moduleLoaders[moduleKey]().catch(() => {}); }

export function App() {
  const [supervision, setSupervision] = useState(isSupervisionRoute);
  useEffect(() => {
    const update = () => setSupervision(isSupervisionRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return (
    <AuthGate>
      {supervision ? <Suspense fallback={<div className="center-state">Carregando supervisão…</div>}><SupervisionPage /></Suspense> : <TalkSessionProvider><TalkSuiteShell renderModule={renderModule} prefetchModule={prefetchModule} /></TalkSessionProvider>}
    </AuthGate>
  );
}
