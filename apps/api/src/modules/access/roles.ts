import type { UserRole } from "@prymeira-talk/shared";

export type Permission =
  | "conversation.read"
  | "conversation.reply"
  | "conversation.assign"
  | "tag.manage"
  | "automation.manage"
  | "campaign.manage"
  | "crm.manage"
  | "workspace.manage";

const permissionsByRole: Record<UserRole, Set<Permission>> = {
  owner: new Set([
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "tag.manage",
    "automation.manage",
    "campaign.manage",
    "crm.manage",
    "workspace.manage"
  ]),
  manager: new Set([
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "tag.manage",
    "automation.manage",
    "campaign.manage",
    "crm.manage"
  ]),
  agent: new Set(["conversation.read", "conversation.reply"])
};

export function canPerform(role: UserRole, permission: Permission) {
  return permissionsByRole[role].has(permission);
}
