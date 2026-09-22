type CurrentUserProfilePrisma = {
  userProfile: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
};

export function readCurrentClerkUserId(authorizationHeader: string | undefined) {
  const token = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  const payload = token?.split(".")[1];

  if (!payload) return null;

  try {
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(normalizedPayload, "base64").toString("utf8")) as {
      sub?: unknown;
    };

    return typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the profile only inside the authenticated workspace. The auth
 * plugin already exposes clerkUserId, but the bearer fallback keeps this safe
 * to reuse in route-level tests and legacy callers.
 */
export async function resolveCurrentUserProfileId(input: {
  prisma: CurrentUserProfilePrisma;
  workspaceId: string;
  clerkUserId?: string | null;
  authorizationHeader?: string | undefined;
}) {
  const currentClerkUserId = input.clerkUserId ?? readCurrentClerkUserId(input.authorizationHeader);

  if (!currentClerkUserId) return null;

  const user = await input.prisma.userProfile.findFirst({
    where: {
      workspaceId: input.workspaceId,
      clerkUserId: currentClerkUserId
    },
    select: { id: true }
  });

  return user?.id ?? null;
}
