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

export interface EvolutionClient {
  createInstance(input: CreateInstanceInput): Promise<CreateInstanceResult>;
  connectInstance(input: ConnectInstanceInput): Promise<ConnectInstanceResult>;
  setWebhook(input: SetWebhookInput): Promise<SetWebhookResult>;
  sendText(input: SendTextInput): Promise<SendTextResult>;
  sendMedia(input: SendMediaInput): Promise<SendMediaResult>;
  sendTemplate?(input: SendTemplateInput): Promise<SendTemplateResult>;
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
      webhookByEvents: false,
      webhookBase64: true,
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

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createEvolutionClient(options: CreateEvolutionClientOptions): EvolutionClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function post(path: string, body: unknown) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: options.apiKey
      },
      body: JSON.stringify(body)
    });
    const responseBody = sanitizeResponseBody(await parseResponseBody(response));

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
        text: input.text
      });

      return {
        providerMessageId: extractProviderMessageId(responseBody),
        raw: responseBody
      };
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
    }
  };
}
