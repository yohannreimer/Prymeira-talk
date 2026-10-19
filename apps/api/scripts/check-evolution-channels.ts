// Verificação SOMENTE LEITURA (apenas GET) das instâncias da Evolution API.
// Uso:
//   EVOLUTION_API_BASE_URL=... EVOLUTION_API_KEY=... \
//   pnpm --filter @prymeira-talk/api exec tsx scripts/check-evolution-channels.ts
import { createEvolutionClient, EvolutionClientError } from "../src/modules/evolution/evolution.client.js";
import {
  buildChannelReport,
  parseInstanceList,
  parseWebhookConfig,
  type ChannelCheckRow,
  type RequestFailure
} from "../src/modules/evolution/evolution-channel-check.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DELAY_BETWEEN_INSTANCES_MS = 250;

const baseUrl = process.env.EVOLUTION_API_BASE_URL?.trim();
const apiKey = process.env.EVOLUTION_API_KEY?.trim();

if (!baseUrl || !apiKey) {
  console.error(
    [
      "Configuração ausente: defina EVOLUTION_API_BASE_URL e EVOLUTION_API_KEY no ambiente.",
      "Este script não lê arquivos .env e não tem valores padrão. Exemplo:",
      "",
      "  EVOLUTION_API_BASE_URL=https://sua-evolution.exemplo.com EVOLUTION_API_KEY=... \\",
      "    pnpm --filter @prymeira-talk/api exec tsx scripts/check-evolution-channels.ts",
      "",
      "O script faz apenas requisições GET (somente leitura)."
    ].join("\n")
  );
  process.exit(1);
}

const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const client = createEvolutionClient({ baseUrl: normalizedBaseUrl, apiKey, fetch: timedFetch });

function statusOf(error: unknown): number | null {
  return error instanceof EvolutionClientError ? error.statusCode : null;
}

async function getJson(path: string): Promise<unknown> {
  const response = await timedFetch(`${normalizedBaseUrl}${path}`, {
    method: "GET",
    headers: { apikey: apiKey! }
  });
  if (!response.ok) throw new EvolutionClientError(response.status, null);
  const text = await response.text();
  return text.trim() === "" ? null : (JSON.parse(text) as unknown);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const globalFailures: RequestFailure[] = [];
let instances: ReturnType<typeof parseInstanceList> = [];
try {
  instances = parseInstanceList(await getJson("/instance/fetchInstances"));
} catch (error) {
  globalFailures.push({ step: "fetchInstances", status: statusOf(error) });
}

const rows: ChannelCheckRow[] = [];
for (const [index, instance] of instances.entries()) {
  if (index > 0) await sleep(DELAY_BETWEEN_INSTANCES_MS);
  const failures: RequestFailure[] = [];

  let clientState: ChannelCheckRow["clientState"] = null;
  try {
    clientState = (await client.getConnectionState?.({ instanceName: instance.name })) ?? null;
  } catch (error) {
    failures.push({ step: "connectionState", status: statusOf(error) });
  }

  let webhook: ChannelCheckRow["webhook"] = null;
  try {
    webhook = parseWebhookConfig(await getJson(`/webhook/find/${encodeURIComponent(instance.name)}`));
  } catch (error) {
    failures.push({ step: "webhook/find", status: statusOf(error) });
  }

  rows.push({
    name: instance.name,
    owner: instance.owner,
    clientState,
    listState: instance.listState,
    webhook,
    failures
  });
}

const report = buildChannelReport(rows, globalFailures);
console.log(report.text);
if (report.warnings.length > 0) {
  console.log("\nAvisos:");
  for (const warning of report.warnings) console.log(`- ${warning}`);
} else {
  console.log("\nSem avisos.");
}
