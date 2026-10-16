import {
  BarChart3,
  BriefcaseBusiness,
  Headphones,
  ListChecks,
  MapPinned,
  Radio,
  Send,
  Settings,
  ShoppingCart,
  Sparkles,
  UserRoundCog,
  Users,
  Workflow
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type TalkModuleKey =
  | "atendimento"
  | "followups"
  | "contatos"
  | "leads"
  | "orcamentos"
  | "canais"
  | "automacoes"
  | "disparos"
  | "relatorios"
  | "equipe"
  | "ia"
  | "atomic_crm"
  | "ajustes";

export type TalkModule = {
  key: TalkModuleKey;
  label: string;
  Icon: LucideIcon;
  /** A paid add-on: the tab only shows once the Hub releases it for the workspace. */
  addon?: "orcamentos";
};

export const talkModules: TalkModule[] = [
  {
    key: "atendimento",
    label: "Atendimento",
    Icon: Headphones
  },
  {
    key: "followups",
    label: "Follow-ups",
    Icon: ListChecks
  },
  {
    key: "contatos",
    label: "Contatos",
    Icon: Users
  },
  {
    key: "leads",
    label: "Leads",
    Icon: MapPinned
  },
  {
    key: "orcamentos",
    label: "Orçamentos",
    Icon: ShoppingCart,
    addon: "orcamentos"
  },
  {
    key: "canais",
    label: "Canais",
    Icon: Radio
  },
  {
    key: "automacoes",
    label: "Automações",
    Icon: Workflow
  },
  {
    key: "disparos",
    label: "Disparos",
    Icon: Send
  },
  {
    key: "relatorios",
    label: "Relatórios",
    Icon: BarChart3
  },
  {
    key: "equipe",
    label: "Equipe",
    Icon: UserRoundCog
  },
  {
    key: "ia",
    label: "Agentes",
    Icon: Sparkles
  },
  {
    key: "atomic_crm",
    label: "Vincula CRM",
    Icon: BriefcaseBusiness
  },
  {
    key: "ajustes",
    label: "Ajustes",
    Icon: Settings
  }
];

export function isTalkModuleKey(value: string | null): value is TalkModuleKey {
  return talkModules.some((module) => module.key === value);
}

export function availableTalkModules(addons: { orcamentos: boolean } | undefined) {
  return talkModules.filter((module) => !module.addon || addons?.[module.addon] === true);
}
