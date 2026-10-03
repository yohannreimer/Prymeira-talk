import { usableContactName } from "../contacts/contact-name.js";
import { parseContactCard } from "../messaging/contact-card.js";
import type { MessageDto, MessageLocation } from "@prymeira-talk/shared";
import { normalizePhoneForStorage } from "../contacts/phone-normalization.js";
import { extractLocation, locationMessageBody } from "./evolution-location.js";

export function resolveWebhookPhone(remoteJid: string, remoteJidAlt?: string): string | null {
  const address = remoteJid.endsWith('@lid') ? remoteJidAlt ?? remoteJid : remoteJid;
  if (/^\d+@lid$/.test(address)) return address;
  if (!address || (address.includes('@') && !address.endsWith('@s.whatsapp.net'))) return null;
  const phone = normalizePhoneForStorage(address.split('@')[0]);
  return phone.length >= 8 && phone.length <= 15 ? phone : null;
}

export function resolveGroupJid(remoteJid: string): string | null {
  return /^\d+(?:-\d+)?@g\.us$/.test(remoteJid) && remoteJid.length <= 80 ? remoteJid : null;
}

export function groupFallbackName(groupJid: string): string {
  return `Grupo ${groupJid.split('@')[0]!.slice(-8)}`;
}

export function normalizeEvolutionEvent(event: string) {
  return event.toLowerCase().replace(/_/g, ".");
}

export function isEditProtocolType(type: unknown) {
  return type === 14 || type === "14" || type === "MESSAGE_EDIT";
}

export function mapEvolutionMessageStatus(status: string | number | undefined): MessageDto["status"] | null {
  const normalized = String(status ?? "").toLowerCase();
  if (["read", "played"].includes(normalized) || normalized === "4") return "read";
  if (["delivered", "delivery_ack"].includes(normalized) || normalized === "3") return "delivered";
  if (["sent", "server_ack", "sended"].includes(normalized) || normalized === "2") return "sent";
  if (["pending", "queued"].includes(normalized) || normalized === "1") return "pending";
  if (["failed", "error"].includes(normalized)) return "failed";
  return null;
}

export function readStringPath(data: unknown, path: string[]) {
  const current = readPath(data, path);
  return typeof current === "string" && current.length > 0 ? current : null;
}

export function readPath(data: unknown, path: string[]): unknown {
  let current = data;

  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function readFirstStringPath(data: unknown, paths: string[][]) {
  for (const path of paths) {
    const value = readStringPath(data, path);

    if (value) {
      return value;
    }
  }

  return null;
}

export function hasRecordPath(data: unknown, path: string[]) {
  let current = data;

  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current !== null && typeof current === "object" && !Array.isArray(current);
}

export function normalizeMediaUrl(value: string | null) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function normalizeMediaMimeType(value: string | null) {
  const mimetype = value?.split(";")[0]?.trim().toLowerCase();

  return mimetype && mimetype.length > 0 ? mimetype : "application/octet-stream";
}

export function normalizeBase64MediaUrl(value: string | null, mimetype: string | null) {
  if (!value) return null;

  if (value.startsWith("data:")) {
    return normalizeMediaUrl(value);
  }

  const compactValue = value.replace(/\s/g, "");

  return compactValue.length > 0
    ? `data:${normalizeMediaMimeType(mimetype)};base64,${compactValue}`
    : null;
}

export function readMessageBase64(message: unknown, messageKey: string) {
  return (
    readStringPath(message, [messageKey, "base64"]) ??
    (hasRecordPath(message, [messageKey]) ? readStringPath(message, ["base64"]) : null)
  );
}

export function unwrapMessage(message: unknown) {
  let current = message;
  for (let depth = 0; depth < 6; depth++) {
    // lottieStickerMessage: WhatsApp's default animated stickers wrap a regular stickerMessage (application/was).
    const wrapper = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage", "lottieStickerMessage"]
      .find((key) => hasRecordPath(current, [key, "message"]));
    if (!wrapper) break;
    current = (current as Record<string, Record<string, unknown>>)[wrapper].message;
  }
  return current;
}

export function attachmentPresentation(message: unknown) {
  message = unwrapMessage(message);
  const fileName = readStringPath(message, ['documentMessage', 'fileName']);
  const caption = readFirstStringPath(message, [['documentMessage', 'caption'], ['imageMessage', 'caption'], ['videoMessage', 'caption']]);
  const mimeType = readFirstStringPath(message, [['videoMessage', 'mimetype'], ['documentMessage', 'mimetype'], ['imageMessage', 'mimetype'], ['audioMessage', 'mimetype']]);
  const raw = message && typeof message === 'object' ? (message as Record<string, unknown>).audioMessage : null;
  const seconds = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).seconds : null;
  return {
    ...(fileName ? { fileName } : {}), ...(caption ? { caption } : {}), ...(mimeType ? { mimeType } : {}),
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? { durationSeconds: seconds } : {})
  };
}

export function extractMessageContent(message: unknown, messageType?: unknown): {
  type: MessageDto["type"];
  body: string | null;
  mediaUrl: string | null;
  preview: string | null;
  contactCards?: Array<{ fullName: string; phoneNumber: string | null }>;
  location?: MessageLocation;
} {
  message = unwrapMessage(message);
  const location = extractLocation(message);
  if (location) {
    const body = locationMessageBody(location);
    const preview = [location.isLive ? 'Última posição recebida' : 'Localização compartilhada', location.name ?? location.address].filter(Boolean).join(': ');
    return { type: 'text', body, preview, mediaUrl: null, location };
  }
  const singleContact = readPath(message, ['contactMessage']);
  const contactArray = readPath(message, ['contactsArrayMessage', 'contacts']);
  const contactCards = (Array.isArray(contactArray) ? contactArray.slice(0, 50) : singleContact ? [singleContact] : [])
    .map(parseContactCard).filter((card): card is NonNullable<typeof card> => card !== null);
  if (contactCards.length) {
    const label = contactCards.length === 1
      ? `Contato compartilhado: ${contactCards[0]!.fullName}${contactCards[0]!.phoneNumber ? ` (${contactCards[0]!.phoneNumber})` : ''}`
      : `${contactCards.length} contatos compartilhados`;
    return { type: 'text', body: label, mediaUrl: null, preview: label, contactCards };
  }
  const text = readFirstStringPath(message, [
    ["conversation"],
    ["extendedTextMessage", "text"]
  ]);

  if (text) {
    return {
      type: "text",
      body: text,
      mediaUrl: null,
      preview: text
    };
  }

  if (hasRecordPath(message, ["templateMessage"]) || messageType === "templateMessage") {
    const title = readStringPath(message, ["templateMessage", "hydratedTemplate", "hydratedTitleText"])?.trim();
    const content = readStringPath(message, ["templateMessage", "hydratedTemplate", "hydratedContentText"])?.trim();
    const body = [title, content].filter(Boolean).join("\n");
    return body
      ? { type: "template", body, mediaUrl: null, preview: body }
      : { type: "system", body: "Template recebido sem texto", mediaUrl: null, preview: "Template recebido sem texto" };
  }

  if (hasRecordPath(message, ["reactionMessage"]) || messageType === "reactionMessage") {
    const emoji = readStringPath(message, ["reactionMessage", "text"]);
    const body = emoji ? `Reagiu com ${emoji}` : "Removeu uma reação";
    return { type: "system", body, mediaUrl: null, preview: body };
  }

  const imageMimetype = readStringPath(message, ["imageMessage", "mimetype"]);
  const imageDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "imageMessage"), imageMimetype);
  const imageUrl =
    imageDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["imageMessage", "url"],
        ["imageMessage", "mediaUrl"]
      ])
    );
  if (imageMimetype || imageUrl) {
    const caption = readStringPath(message, ["imageMessage", "caption"]);
    const body = caption ?? "Imagem recebida";

    return {
      type: "image",
      body,
      mediaUrl: imageUrl,
      preview: body
    };
  }

  const stickerMimetype = readStringPath(message, ["stickerMessage", "mimetype"]);
  const stickerDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "stickerMessage"), stickerMimetype ?? "image/webp");
  const stickerUrl =
    stickerDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["stickerMessage", "url"],
        ["stickerMessage", "mediaUrl"]
      ])
    );
  if (hasRecordPath(message, ["stickerMessage"]) || messageType === "stickerMessage") {
    return {
      type: "image",
      body: "Figurinha recebida",
      mediaUrl: stickerUrl,
      preview: "Figurinha recebida"
    };
  }

  const audioMimetype = readStringPath(message, ["audioMessage", "mimetype"]);
  const audioDataUrl = normalizeBase64MediaUrl(readMessageBase64(message, "audioMessage"), audioMimetype);
  const audioUrl =
    audioDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["audioMessage", "url"],
        ["audioMessage", "mediaUrl"]
      ])
    );
  if (audioMimetype || audioUrl) {
    return {
      type: "audio",
      body: "Áudio recebido",
      mediaUrl: audioUrl,
      preview: "Áudio recebido"
    };
  }

  const documentMimetype =
    readStringPath(message, ["documentMessage", "mimetype"]) ??
    readStringPath(message, ["videoMessage", "mimetype"]);
  const documentDataUrl =
    normalizeBase64MediaUrl(readMessageBase64(message, "documentMessage"), documentMimetype) ??
    normalizeBase64MediaUrl(readMessageBase64(message, "videoMessage"), documentMimetype);
  const documentUrl =
    documentDataUrl ??
    normalizeMediaUrl(
      readFirstStringPath(message, [
        ["documentMessage", "url"],
        ["documentMessage", "mediaUrl"],
        ["videoMessage", "url"],
        ["videoMessage", "mediaUrl"]
      ])
    );
  if (documentMimetype || documentUrl) {
    const body =
      readStringPath(message, ["documentMessage", "fileName"]) ??
      readStringPath(message, ["documentMessage", "caption"]) ??
      readStringPath(message, ["videoMessage", "caption"]) ??
      (hasRecordPath(message, ["videoMessage"]) || documentMimetype?.toLowerCase().startsWith('video/') ? "Vídeo recebido" : "Arquivo recebido");

    return {
      type: "file",
      body,
      mediaUrl: documentUrl,
      preview: body
    };
  }

  return {
    type: "system",
    body: "Mensagem não reconhecida",
    mediaUrl: null,
    preview: "Mensagem não reconhecida"
  };
}

export function extractMessageEdit(data: unknown, event: string): {
  targetId: string;
  body: string;
} | null {
  const message = unwrapMessage(readPath(data, ["message"]));
  const protocol = readPath(message, ["protocolMessage"]);
  const protocolType = readPath(protocol, ["type"]);
  const isProtocolEdit = isEditProtocolType(protocolType);
  const updateMessage = readPath(data, ["update", "message"]);
  const editedContent = isProtocolEdit
    ? readPath(protocol, ["editedMessage"])
    : readPath(updateMessage, ["editedMessage", "message"])
      ?? readPath(message, ["editedMessage", "message"]);
  const candidate = editedContent ?? (event === "messages.edited" ? updateMessage ?? message : null);
  const content = candidate ? extractMessageContent(candidate) : null;
  if (content?.type !== "text" || !content.body) return null;

  const targetId = isProtocolEdit
    ? readStringPath(protocol, ["key", "id"])
    : readFirstStringPath(data, [["key", "id"], ["keyId"], ["id"]]);
  return targetId ? { targetId, body: content.body } : null;
}

export function extractPushName(data: unknown) {
  const candidates = [
    readStringPath(data, ["pushName"]),
    readStringPath(data, ["data", "pushName"]),
    readStringPath(data, ["key", "pushName"]),
    readStringPath(data, ["data", "key", "pushName"])
  ];

  for (const value of candidates) {
    const name = usableContactName(value);
    if (name) return name;
  }
  return null;
}

export function extractQrCode(data: unknown) {
  return (
    readStringPath(data, ["qrcode", "code"]) ??
    readStringPath(data, ["qrcode", "base64"]) ??
    readStringPath(data, ["qrCode"]) ??
    readStringPath(data, ["code"]) ??
    readStringPath(data, ["base64"])
  );
}
