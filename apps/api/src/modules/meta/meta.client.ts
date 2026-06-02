const SECRET_RESPONSE_KEYS = new Set([
  "access_token",
  "authorization",
  "password",
  "secret",
  "token"
]);

export class MetaClientError extends Error {
  readonly statusCode: number;
  readonly responseBody: unknown;

  constructor(statusCode: number, responseBody: unknown) {
    super(`Meta Graph API request failed with status ${statusCode}`);
    this.name = "MetaClientError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export interface MetaTemplateComponentParameter {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface MetaTemplateComponent {
  type: string;
  parameters?: MetaTemplateComponentParameter[];
  [key: string]: unknown;
}

export interface MetaTemplateRecord {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: MetaTemplateComponent[];
}

export interface SendMetaTextInput {
  phoneNumberId: string;
  to: string;
  text: string;
}

export interface SendMetaTemplateInput {
  phoneNumberId: string;
  to: string;
  name: string;
  language: string;
  components?: MetaTemplateComponent[];
}

export interface SendMetaMessageResult {
  providerMessageId: string | null;
  raw: unknown;
}

export interface ListMetaMessageTemplatesInput {
  wabaId: string;
}

export interface ListMetaMessageTemplatesResult {
  templates: MetaTemplateRecord[];
  raw: unknown;
}

export interface TestMetaConnectionInput {
  phoneNumberId: string;
}

export interface TestMetaConnectionResult {
  ok: true;
  raw: unknown;
}

export interface MetaClient {
  sendText(input: SendMetaTextInput): Promise<SendMetaMessageResult>;
  sendTemplate(input: SendMetaTemplateInput): Promise<SendMetaMessageResult>;
  listMessageTemplates(
    input: ListMetaMessageTemplatesInput
  ): Promise<ListMetaMessageTemplatesResult>;
  testConnection(input: TestMetaConnectionInput): Promise<TestMetaConnectionResult>;
}

export interface CreateMetaClientOptions {
  graphApiBaseUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function extractProviderMessageId(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return null;
  }

  return getString(body.messages[0], "id") ?? null;
}

function normalizeTemplateComponent(value: unknown): MetaTemplateComponent | null {
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
    parameters: Array.isArray(value.parameters)
      ? value.parameters.filter(isRecord).map((parameter) => ({
          ...parameter,
          type: getString(parameter, "type") ?? "text"
        }))
      : undefined
  };
}

function normalizeTemplateRecord(value: unknown): MetaTemplateRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = getString(value, "id");
  const name = getString(value, "name");
  const language = getString(value, "language");

  if (!id || !name || !language) {
    return null;
  }

  return {
    id,
    name,
    language,
    category: getString(value, "category") ?? "UNKNOWN",
    status: getString(value, "status") ?? "UNKNOWN",
    components: Array.isArray(value.components)
      ? value.components.flatMap((component) => {
          const normalized = normalizeTemplateComponent(component);
          return normalized ? [normalized] : [];
        })
      : []
  };
}

function listTemplatesPath(wabaId: string) {
  return `/${encodeURIComponent(
    wabaId
  )}/message_templates?fields=id,name,language,category,status,components&limit=100`;
}

export function createMetaClient(options: CreateMetaClientOptions): MetaClient {
  const baseUrl = options.graphApiBaseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request(path: string, init: RequestInit) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        ...init.headers
      }
    });
    const responseBody = sanitizeResponseBody(await parseResponseBody(response));

    if (!response.ok) {
      throw new MetaClientError(response.status, responseBody);
    }

    return responseBody;
  }

  async function post(path: string, body: unknown) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function get(path: string) {
    return request(path, { method: "GET" });
  }

  return {
    async sendText(input) {
      const responseBody = await post(`/${encodeURIComponent(input.phoneNumberId)}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to,
        type: "text",
        text: {
          preview_url: false,
          body: input.text
        }
      });

      return {
        providerMessageId: extractProviderMessageId(responseBody),
        raw: responseBody
      };
    },

    async sendTemplate(input) {
      const responseBody = await post(`/${encodeURIComponent(input.phoneNumberId)}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to,
        type: "template",
        template: {
          name: input.name,
          language: { code: input.language },
          ...(input.components ? { components: input.components } : {})
        }
      });

      return {
        providerMessageId: extractProviderMessageId(responseBody),
        raw: responseBody
      };
    },

    async listMessageTemplates(input) {
      const responseBody = await get(listTemplatesPath(input.wabaId));
      const data = isRecord(responseBody) && Array.isArray(responseBody.data) ? responseBody.data : [];

      return {
        templates: data.flatMap((template) => {
          const normalized = normalizeTemplateRecord(template);
          return normalized ? [normalized] : [];
        }),
        raw: responseBody
      };
    },

    async testConnection(input) {
      const responseBody = await get(
        `/${encodeURIComponent(input.phoneNumberId)}?fields=id,display_phone_number,verified_name`
      );

      return {
        ok: true,
        raw: responseBody
      };
    }
  };
}
