import { createDecipheriv, hkdfSync } from "node:crypto";
import type { HistoryRecord } from "./evolution-history.js";

type EncryptedEdit = {
  targetId: string;
  iv: Buffer;
  payload: Buffer;
  senderJids: string[];
};

const directJid = (value: unknown): value is string =>
  typeof value === "string" && /^\d+@(s\.whatsapp\.net|lid)$/.test(value);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function bytes(value: unknown, maxLength: number): Buffer | null {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.length <= maxLength ? decoded : null;
}

function jids(key: Record<string, unknown> | null): string[] {
  return [key?.participant, key?.remoteJid, key?.participantAlt, key?.remoteJidAlt]
    .filter(directJid);
}

export function extractEncryptedMessageEdit(data: unknown): EncryptedEdit | null {
  const wrapper = object(data);
  const message = object(wrapper?.message);
  const sealed = object(message?.secretEncryptedMessage);
  if (!sealed || (sealed.secretEncType !== 2 && sealed.secretEncType !== "MESSAGE_EDIT")) return null;
  const targetId = object(sealed.targetMessageKey)?.id;
  const iv = bytes(sealed.encIv, 32);
  const payload = bytes(sealed.encPayload, 16 * 1024);
  if (typeof targetId !== "string" || !targetId || !iv || !payload || payload.length <= 16) return null;
  return { targetId, iv, payload, senderJids: [...new Set(jids(object(wrapper?.key)))] };
}

type Field = { number: number; wire: number; value: Buffer | number };

function varint(buffer: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  let factor = 1;
  for (let index = offset; index < buffer.length && index - offset < 10; index++) {
    const octet = buffer[index]!;
    value += (octet & 127) * factor;
    if (!Number.isSafeInteger(value)) return null;
    if (!(octet & 128)) return { value, next: index + 1 };
    factor *= 128;
  }
  return null;
}

function fields(buffer: Buffer): Field[] | null {
  if (buffer.length > 16 * 1024) return null;
  const result: Field[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = varint(buffer, offset);
    if (!tag || tag.value < 8) return null;
    offset = tag.next;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (wire === 0) {
      const item = varint(buffer, offset);
      if (!item) return null;
      result.push({ number, wire, value: item.value });
      offset = item.next;
    } else if (wire === 2) {
      const length = varint(buffer, offset);
      if (!length || length.value > buffer.length - length.next) return null;
      result.push({ number, wire, value: buffer.subarray(length.next, length.next + length.value) });
      offset = length.next + length.value;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > buffer.length) return null;
    } else return null;
  }
  return result;
}

function fieldBytes(items: Field[], number: number): Buffer | null {
  const value = items.find((item) => item.number === number && item.wire === 2)?.value;
  return Buffer.isBuffer(value) ? value : null;
}

function fieldNumber(items: Field[], number: number): number | null {
  const value = items.find((item) => item.number === number && item.wire === 0)?.value;
  return typeof value === "number" ? value : null;
}

function textFromMessage(message: Buffer): string | null {
  const items = fields(message);
  if (!items) return null;
  const text = fieldBytes(items, 1) ?? (() => {
    const extended = fieldBytes(items, 6);
    return extended ? fieldBytes(fields(extended) ?? [], 1) : null;
  })();
  if (!text) return null;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(text);
    return decoded.trim() ? decoded : null;
  } catch { return null; }
}

function editedText(plaintext: Buffer, targetId: string): string | null {
  const message = fields(plaintext);
  const protocol = message && fieldBytes(message, 12);
  const protocolFields = protocol && fields(protocol);
  if (!protocolFields || fieldNumber(protocolFields, 2) !== 14) return null;
  const key = fieldBytes(protocolFields, 1);
  const keyFields = key && fields(key);
  const id = keyFields && fieldBytes(keyFields, 3);
  if (!id || id.toString("utf8") !== targetId) return null;
  const edit = fieldBytes(protocolFields, 14);
  return edit ? textFromMessage(edit) : null;
}

export function decryptEncryptedMessageEdit(edit: EncryptedEdit, original: HistoryRecord): string | null {
  if (original.key.id !== edit.targetId) return null;
  const secret = bytes(object(original.message.messageContextInfo)?.messageSecret, 64);
  if (!secret || secret.length !== 32) return null;
  const originalJids = [...new Set(jids(original.key))];
  for (const originalSender of originalJids) {
    for (const modificationSender of edit.senderJids) {
      const info = Buffer.from(edit.targetId + originalSender + modificationSender + "Message Edit", "utf8");
      const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(32), info, 32));
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, edit.iv);
        decipher.setAAD(Buffer.alloc(0));
        decipher.setAuthTag(edit.payload.subarray(edit.payload.length - 16));
        const plaintext = Buffer.concat([
          decipher.update(edit.payload.subarray(0, edit.payload.length - 16)), decipher.final()
        ]);
        const text = editedText(plaintext, edit.targetId);
        if (text) return text;
      } catch { /* An alternate JID may be needed when WhatsApp migrates between PN and LID. */ }
    }
  }
  return null;
}
