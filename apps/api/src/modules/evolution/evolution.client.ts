const EVOLUTION_EVENTS = [
  "QRCODE_UPDATED",
  "CONNECTION_UPDATE",
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "SEND_MESSAGE"
] as const;

const SECRET_RESPONSE_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "token",
  "access_token",
  "secret",
  "password"
]);

export class EvolutionClientError extends Error {
  readonly statusCode: number;
  readonly responseBody: unknown;

  constructor(statusCode: number, responseBody: unknown) {
    super(`Evolution API request failed with status ${statusCode}`);
    this.name = "EvolutionClientError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export interface CreateEvolutionClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface CreateInstanceInput {
  instanceName: string;
  webhookUrl: string;
  webhookSecret: string;
}

export interface CreateInstanceResult {
  instanceName: string;
  qrCode: string | null;
  raw: unknown;
}

export interface ConnectInstanceInput {
  instanceName: string;
}

export interface ConnectInstanceResult {
  instanceName: string;
  qrCode: string | null;
  raw: unknown;
}

export interface SetWebhookInput {
  instanceName: string;
  webhookUrl: string;
  webhookSecret: string;
}

export interface SetWebhookResult {
  raw: unknown;
}

export interface SendTextInput {
  instanceName: string;
  number: string;
  text: string;
  linkPreview?: boolean;
}

export interface SendTextResult {
  providerMessageId: string | null;
  raw: unknown;
}

export interface SendMediaInput {
  instanceName: string;
  number: string;
  mediatype: "image" | "video" | "document";
  mimetype: string;
  media: string;
  fileName: string;
  caption?: string;
}

export interface SendMediaResult {
  providerMessageId: string | null;
  raw: unknown;
}

export interface SendTemplateInput {
  instanceName: string;
  number: string;
  name: string;
  language: string;
  components?: unknown[];
}

export interface SendTemplateResult {
  providerMessageId: string | null;
  raw: unknown;
}

export interface EvolutionTemplateComponent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface EvolutionTemplateRecord {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  preview: string | null;
  components: EvolutionTemplateComponent[];
}

export interface ListTemplatesInput {
  instanceName: string;
}

export interface ListTemplatesResult {
  templates: EvolutionTemplateRecord[];
  raw: unknown;
}

export interface CheckWhatsappNumbersAvailabilityInput {
  instanceName: string;
  numbers: string[];
}

export interface WhatsappNumberAvailability {
  phone: string;
  available: boolean;
  jid?: string;
}

export interface CheckWhatsappNumbersAvailabilityResult {
  numbers: WhatsappNumberAvailability[];
  raw: unknown;
}

export interface EvolutionClient {
  sendAudio?(input: { instanceName: string; number: string; audio: string }): Promise<SendMediaResult>;
  fetchProfilePicture?(input: { instanceName: string; number: string }): Promise<string | null>;
  fetchMedia?(input: { instanceName: string; id: string }): Promise<string>;
  createInstance(input: CreateInstanceInput): Promise<CreateInstanceResult>;
  connectInstance(input: ConnectInstanceInput): Promise<ConnectInstanceResult>;
  setWebhook(input: SetWebhookInput): Promise<SetWebhookResult>;
  sendText(input: SendTextInput): Promise<SendTextResult>;
  sendMedia(input: SendMediaInput): Promise<SendMediaResult>;
  sendTemplate?(input: SendTemplateInput): Promise<SendTemplateResult>;
  listTemplates?(input: ListTemplatesInput): Promise<ListTemplatesResult>;
  checkWhatsappNumbersAvailability?(
    input: CheckWhatsappNumbersAvailabilityInput
  ): Promise<CheckWhatsappNumbersAvailabilityResult>;
}

export interface EvolutionClientWithAvailability extends EvolutionClient {
  checkWhatsappNumbersAvailability(
    input: CheckWhatsappNumbersAvailabilityInput
  ): Promise<CheckWhatsappNumbersAvailabilityResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function sanitizeResponseBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponseBody(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_RESPONSE_KEYS.has(key.toLowerCase()) ? "[redacted]" : sanitizeResponseBody(child)
    ])
  );
}

function extractQrCode(body: unknown): string | null {
  const qrcode = getRecord(body, "qrcode");

  return (
    getString(qrcode, "code") ??
    getString(qrcode, "base64") ??
    getString(body, "base64") ??
    getString(body, "code") ??
    null
  );
}

function extractProviderMessageId(body: unknown): string | null {
  const key = getRecord(body, "key");
  const message = getRecord(body, "message");
  const messageKey = getRecord(message, "key");

  return (
    getString(key, "id") ??
    getString(messageKey, "id") ??
    getString(body, "messageId") ??
    getString(body, "id") ??
    null
  );
}

function extractInstanceName(body: unknown, fallback: string): string {
  return getString(getRecord(body, "instance"), "instanceName") ?? fallback;
}

function normalizeTemplateComponent(value: unknown): EvolutionTemplateComponent | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = getString(value, "type");
  if (!type) {
    return null;
  }

  return {
    ...value,
    type,
    text: getString(value, "text")
  };
}

function extractTemplatePreview(components: EvolutionTemplateComponent[]) {
  const bodyComponent = components.find((component) => component.type.toLowerCase() === "body");
  const text = bodyComponent?.text ?? components.find((component) => component.text)?.text ?? null;

  return text?.replace(/\s+/g, " ").trim() || null;
}

function normalizeTemplateRecord(value: unknown): EvolutionTemplateRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = getString(value, "name");
  const language = getString(value, "language");

  if (!name || !language) {
    return null;
  }

  const components = Array.isArray(value.components)
    ? value.components.flatMap((component) => {
        const normalized = normalizeTemplateComponent(component);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    id: getString(value, "id") ?? `${name}:${language}`,
    name,
    language,
    status: getString(value, "status") ?? "UNKNOWN",
    category: getString(value, "category") ?? "UNKNOWN",
    preview: extractTemplatePreview(components),
    components
  };
}

function collectTemplateRecords(value: unknown, depth = 0): EvolutionTemplateRecord[] {
  if (depth > 5) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTemplateRecords(item, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const template = normalizeTemplateRecord(value);
  if (template) {
    return [template];
  }

  return ["templates", "data", "result", "response", "items"].flatMap((key) =>
    collectTemplateRecords(value[key], depth + 1)
  );
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStrings);
  }

  return [];
}

function availabilityRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of ["data", "response", "result", "numbers", "whatsappNumbers"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return null;
}

function normalizeAvailabilityRecord(value: unknown): WhatsappNumberAvailability | null {
  if (!isRecord(value)) return null;
  const jid = getString(value, "jid") ?? getString(value, "id");
  const rawPhone = getString(value, "number") ?? getString(value, "phone") ?? jid?.split("@")[0];
  const phone = rawPhone?.replace(/\D/g, "") ?? "";
  if (!/^\d{8,15}$/.test(phone)) return null;
  const flag = value.exists ?? value.available ?? value.isWhatsApp ?? value.isWhatsapp;
  const status = getString(value, "status")?.toLowerCase();
  const available = typeof flag === "boolean"
    ? flag
    : status === "available" || status === "exists" || status === "registered"
      ? true
      : status === "unavailable" || status === "not_found" || status === "unregistered"
        ? false
        : null;
  if (available === null) return null;
  return { phone, available, ...(jid ? { jid } : {}) };
}

export function isEvolutionInstanceNameInUseError(error: unknown): error is EvolutionClientError {
  return (
    error instanceof EvolutionClientError &&
    error.statusCode === 403 &&
    collectStrings(error.responseBody).some((message) => /already in use/i.test(message))
  );
}

export function isEvolutionLicenseRequiredError(error: unknown): error is EvolutionClientError {
  return (
    error instanceof EvolutionClientError &&
    collectStrings(error.responseBody).some((message) => message === "LICENSE_REQUIRED")
  );
}

function webhookPayload(webhookUrl: string, webhookSecret: string) {
  return {
    url: webhookUrl,
    byEvents: false,
    base64: true,
    headers: {
      "x-prymeira-talk-secret": webhookSecret,
      "Content-Type": "application/json"
    },
    events: EVOLUTION_EVENTS
  };
}

function setWebhookPayload(webhookUrl: string, webhookSecret: string) {
  return {
    webhook: {
      enabled: true,
      url: webhookUrl,
      byEvents: false,
      base64: true,
      headers: {
        "x-prymeira-talk-secret": webhookSecret,
        "Content-Type": "application/json"
      },
      events: EVOLUTION_EVENTS
    }
  };
}

function normalizeMediaPayload(media: string) {
  const trimmedMedia = media.trim();
  const base64Match = /^data:[^,]+;base64,(.+)$/i.exec(trimmedMedia);

  return base64Match?.[1] ?? trimmedMedia;
}

async function parseResponseBody(response: Response, maxBytes?: number) {
  let text: string;
  if (maxBytes && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('EVOLUTION_RESPONSE_LIMIT'); }
        chunks.push(part.value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else text = await response.text();
  if (text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createEvolutionClient(options: CreateEvolutionClientOptions): EvolutionClientWithAvailability {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function post(path: string, body: unknown, timeoutMs?: number) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: options.apiKey
      },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
    const responseBody = sanitizeResponseBody(await parseResponseBody(response, timeoutMs ? 36 * 1024 * 1024 : undefined));

    if (!response.ok) {
      throw new EvolutionClientError(response.status, responseBody);
    }

    return responseBody;
  }

  async function get(path: string) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        apikey: options.apiKey
      }
    });
    const responseBody = sanitizeResponseBody(await parseResponseBody(response));

    if (!response.ok) {
      throw new EvolutionClientError(response.status, responseBody);
    }

    return responseBody;
  }

  return {
    async checkWhatsappNumbersAvailability(input) {
      const responseBody = await post(
        `/chat/whatsappNumbers/${encodeURIComponent(input.instanceName)}`,
        { numbers: input.numbers }
      );
      const records = availabilityRecords(responseBody);
      if (!records) throw new Error("EVOLUTION_AVAILABILITY_INVALID_RESPONSE");
      return {
        numbers: records.flatMap((record) => {
          const normalized = normalizeAvailabilityRecord(record);
          return normalized ? [normalized] : [];
        }),
        raw: responseBody
      };
    },
    async fetchProfilePicture(input) {
      const data = await post(`/chat/fetchProfilePictureUrl/${encodeURIComponent(input.instanceName)}`, { number: input.number }, 8000);
      const url = getString(data, 'profilePictureUrl');
      if (!url) return null;
      try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
    },
    async fetchMedia(input) {
      const data = await post(`/chat/getBase64FromMediaMessage/${encodeURIComponent(input.instanceName)}`, { message: { key: { id: input.id } }, convertToMp4: false }, 15000);
      const base64 = getString(data, 'base64');
      const mime = getString(data, 'mimetype')?.split(';')[0].trim().toLowerCase();
      if (!base64 || !mime || base64.length > 36 * 1024 * 1024) throw new Error('MEDIA_UNAVAILABLE');
      return `data:${mime};base64,${base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '')}`;
    },
    async createInstance(input) {
      const responseBody = await post("/instance/create", {
        instanceName: input.instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        webhook: webhookPayload(input.webhookUrl, input.webhookSecret)
      });

      return {
        instanceName: extractInstanceName(responseBody, input.instanceName),
        qrCode: extractQrCode(responseBody),
        raw: responseBody
      };
    },

    async connectInstance(input) {
      const responseBody = await get(`/instance/connect/${encodeURIComponent(input.instanceName)}`);

      return {
        instanceName: extractInstanceName(responseBody, input.instanceName),
        qrCode: extractQrCode(responseBody),
        raw: responseBody
      };
    },

    async setWebhook(input) {
      const responseBody = await post(
        `/webhook/set/${encodeURIComponent(input.instanceName)}`,
        setWebhookPayload(input.webhookUrl, input.webhookSecret)
      );

      return { raw: responseBody };
    },

    async sendText(input) {
      const responseBody = await post(`/message/sendText/${encodeURIComponent(input.instanceName)}`, {
        number: input.number,
        text: input.text,
        linkPreview: input.linkPreview ?? false
      });

      return {
        providerMessageId: extractProviderMessageId(responseBody),
        raw: responseBody
      };
    },

    async sendAudio(input) {
      const responseBody = await post(`/message/sendWhatsAppAudio/${encodeURIComponent(input.instanceName)}`, {
        number: input.number, audio: normalizeMediaPayload(input.audio), encoding: false
      }, 60000);
      return { providerMessageId: extractProviderMessageId(responseBody), raw: responseBody };
    },

    async sendMedia(input) {
      const responseBody = await post(`/message/sendMedia/${encodeURIComponent(input.instanceName)}`, {
        number: input.number,
        mediatype: input.mediatype,
        mimetype: input.mimetype,
        caption: input.caption ?? "",
        media: normalizeMediaPayload(input.media),
        fileName: input.fileName
      });

      return {
        providerMessageId: extractProviderMessageId(responseBody),
        raw: responseBody
      };
    },

    async sendTemplate(input) {
      const responseBody = await post(`/message/sendTemplate/${encodeURIComponent(input.instanceName)}`, {
        number: input.number,
        name: input.name,
        language: input.language,
        ...(input.components ? { components: input.components } : {})
      });

      return {
        providerMessageId: extractProviderMessageId(responseBody),
        raw: responseBody
      };
    },

    async listTemplates(input) {
      const responseBody = await get(`/template/find/${encodeURIComponent(input.instanceName)}`);

      return {
        templates: collectTemplateRecords(responseBody),
        raw: responseBody
      };
    }
  };
}
