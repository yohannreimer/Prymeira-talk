import type { LeadWhatsappStatus } from "@prymeira-talk/shared";

export function aggregateLeadWhatsappStatus(
  phoneCount: number,
  statuses: LeadWhatsappStatus[]
): LeadWhatsappStatus {
  if (statuses.includes("available")) return "available";
  if (statuses.includes("checking")) return "checking";
  if (statuses.includes("failed")) return "failed";
  if (phoneCount > 0 && statuses.length === phoneCount && statuses.every((status) => status === "unavailable")) {
    return "unavailable";
  }
  return "unverified";
}
