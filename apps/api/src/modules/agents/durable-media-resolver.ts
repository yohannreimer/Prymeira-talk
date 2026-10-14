import { AgentMediaError, resolveAgentMedia } from "./agent-media-resolver.js";
import type { MessageMediaService } from "../conversations/message-media.js";

type MediaTarget = { id: string; workspaceId: string; conversationId: string };

/** With a durable copy an attachment is read from it (provider-independent, survives expired or encrypted
 * URLs); the caller's processing limit and allowed types still apply. Without one, or when no copy exists
 * yet, the legacy resolver runs exactly as before. */
export function durableMediaResolverFor(
  durable: Pick<MessageMediaService, "read"> | undefined,
  legacy: typeof resolveAgentMedia = resolveAgentMedia
) {
  return (target: MediaTarget): typeof resolveAgentMedia => !durable ? legacy : async (args) => {
    const stored = await durable
      .read({ workspaceId: target.workspaceId, conversationId: target.conversationId, messageId: target.id, variant: "original" })
      .catch(() => null);
    if (!stored) return legacy(args);
    if (stored.bytes.length > args.policy.maxBytes) throw new AgentMediaError("MEDIA_TOO_LARGE", "Inbound media exceeds the size limit.");
    if (!args.policy.allowedMimeTypes.has(stored.mimeType)) throw new AgentMediaError("UNSUPPORTED_MEDIA_TYPE", "Inbound media type is unsupported.");
    return { bytes: stored.bytes, mimeType: stored.mimeType, source: "durable" as const };
  };
}
