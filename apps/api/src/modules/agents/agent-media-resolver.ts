import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type AgentMediaPolicy = {
  kind: "image" | "audio";
  maxBytes: number;
  allowedMimeTypes: ReadonlySet<string>;
};

export type AgentMediaErrorCode =
  | "MEDIA_UNAVAILABLE"
  | "INVALID_MEDIA_URL"
  | "INVALID_BASE64"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_TIMEOUT"
  | "MEDIA_NETWORK_BLOCKED";

export class AgentMediaError extends Error {
  constructor(public readonly code: AgentMediaErrorCode, message: string) {
    super(message);
    this.name = "AgentMediaError";
  }
}

export type ResolvedAgentMedia = {
  bytes: Buffer;
  mimeType: string;
  source: "data_url" | "remote";
};

type ResolveHost = (hostname: string) => Promise<string[]>;

const MAX_REDIRECTS = 3;

function normalizeMimeType(value: string | null | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assertAllowedMimeType(mimeType: string, policy: AgentMediaPolicy) {
  if (!policy.allowedMimeTypes.has(mimeType)) {
    throw new AgentMediaError("UNSUPPORTED_MEDIA_TYPE", "Inbound media type is unsupported.");
  }
}

function assertSize(size: number, policy: AgentMediaPolicy) {
  if (size > policy.maxBytes) {
    throw new AgentMediaError("MEDIA_TOO_LARGE", "Inbound media exceeds the size limit.");
  }
}

function decodeDataUrl(mediaUrl: string, policy: AgentMediaPolicy): ResolvedAgentMedia {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(mediaUrl);
  if (!match) {
    throw new AgentMediaError("INVALID_MEDIA_URL", "Inbound media data URL is invalid.");
  }

  const mimeType = normalizeMimeType(match[1]);
  assertAllowedMimeType(mimeType, policy);

  const encoded = match[2].replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new AgentMediaError("INVALID_BASE64", "Inbound media encoding is invalid.");
  }

  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== encoded.replace(/=+$/, "")) {
    throw new AgentMediaError("INVALID_BASE64", "Inbound media encoding is invalid.");
  }
  assertSize(bytes.length, policy);

  return { bytes, mimeType, source: "data_url" };
}

function isBlockedIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isBlockedIp(address: string) {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version !== 6) return true;

  const normalized = address.toLowerCase().split("%", 1)[0];
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  ) {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? isBlockedIpv4(mapped[1]) : false;
}

async function defaultResolveHost(hostname: string) {
  const normalizedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const literalVersion = isIP(normalizedHostname);
  if (literalVersion) return [normalizedHostname];
  const records = await lookup(normalizedHostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function assertPublicTarget(url: URL, resolveHost: ResolveHost) {
  let addresses: string[];
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media host could not be resolved.");
  }
  if (addresses.length === 0 || addresses.some(isBlockedIp)) {
    throw new AgentMediaError("MEDIA_NETWORK_BLOCKED", "Inbound media target is not public.");
  }
}

async function readBoundedBody(response: Response, policy: AgentMediaPolicy) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength)) assertSize(declaredLength, policy);

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      assertSize(total, policy);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchRemoteMedia(input: {
  mediaUrl: string;
  policy: AgentMediaPolicy;
  fetchImpl: typeof fetch;
  resolveHost: ResolveHost;
  timeoutMs: number;
}): Promise<ResolvedAgentMedia> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(input.mediaUrl);
  } catch {
    throw new AgentMediaError("INVALID_MEDIA_URL", "Inbound media URL is invalid.");
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!['http:', 'https:'].includes(currentUrl.protocol)) {
      throw new AgentMediaError("INVALID_MEDIA_URL", "Inbound media URL protocol is invalid.");
    }
    await assertPublicTarget(currentUrl, input.resolveHost);

    let response: Response;
    try {
      response = await input.fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs)
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError" || name === "TimeoutError") {
        throw new AgentMediaError("MEDIA_TIMEOUT", "Inbound media download timed out.");
      }
      throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media download failed.");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) {
        throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media redirect failed.");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    if (!response.ok) {
      throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media download failed.");
    }

    const mimeType = normalizeMimeType(response.headers.get("content-type"));
    assertAllowedMimeType(mimeType, input.policy);
    const bytes = await readBoundedBody(response, input.policy);
    return { bytes, mimeType, source: "remote" };
  }

  throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media redirect failed.");
}

export async function resolveAgentMedia(input: {
  mediaUrl: string | null | undefined;
  policy: AgentMediaPolicy;
  fetchImpl?: typeof fetch;
  resolveHost?: ResolveHost;
  timeoutMs?: number;
}): Promise<ResolvedAgentMedia> {
  if (!input.mediaUrl) {
    throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media is unavailable.");
  }
  if (input.mediaUrl.startsWith("data:")) {
    return decodeDataUrl(input.mediaUrl, input.policy);
  }
  return await fetchRemoteMedia({
    mediaUrl: input.mediaUrl,
    policy: input.policy,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    resolveHost: input.resolveHost ?? defaultResolveHost,
    timeoutMs: input.timeoutMs ?? 15_000
  });
}
