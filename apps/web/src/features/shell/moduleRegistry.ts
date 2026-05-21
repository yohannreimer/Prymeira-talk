import {
  BarChart3,
  BriefcaseBusiness,
  Headphones,
  Radio,
  Send,
  Settings,
  Sparkles,
  UserRoundCog,
  Users,
  Workflow
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type TalkModuleKey =
  | "atendimento"
  | "contatos"
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
};

export const talkModules: TalkModule[] = [
  {
    key: "atendimento",
    label: "Atendimento",
    Icon: Headphones
  },
  {
    key: "contatos",
    label: "Contatos",
    Icon: Users
  },
  {
    key: "canais",
    label: "Canais",
    Icon: Radio
  },
  {
    key: "automacoes",
    label: "Automacoes",
    Icon: Workflow
  },
  {
    key: "disparos",
    label: "Disparos",
    Icon: Send
  },
  {
    key: "relatorios",
    label: "Relatorios",
    Icon: BarChart3
  },
  {
    key: "equipe",
    label: "Equipe",
    Icon: UserRoundCog
  },
  {
    key: "ia",
    label: "IA",
    Icon: Sparkles
  },
  {
    key: "atomic_crm",
    label: "Atomic CRM",
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
