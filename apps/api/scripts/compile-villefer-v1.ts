import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileHistoricalTraining } from "../src/modules/agents/historical-training-compiler.js";
import { villeferV1Definition } from "../src/modules/agents/villefer-v1-definition.js";

const sourceRootValue = process.env.VILLEFER_HISTORY_ROOT?.trim();
if (!sourceRootValue) {
  throw new Error(
    "VILLEFER_HISTORY_ROOT must point to the directory containing data/ and analysis/."
  );
}

const sourceRoot = resolve(sourceRootValue);
const outputRoot = resolve(
  process.env.VILLEFER_OUTPUT_DIR?.trim() || "../../artifacts/agents/villefer"
);
const sourceSlugs = ["henry", "diogo", "villefer-geral", "junior-villefer"] as const;

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writePrivate(path: string, content: string) {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function stableJson(value: unknown) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)])
    );
  }
  return value;
}

async function main() {
  const inputs = await Promise.all(
    sourceSlugs.map(async (slug) => ({
      history: await readJson(resolve(sourceRoot, "data", `${slug}-history.json`)),
      baseline: await readJson(resolve(sourceRoot, "analysis", `${slug}-baseline.json`))
    }))
  );
  const artifacts = compileHistoricalTraining({
    inputs,
    definition: villeferV1Definition
  });

  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    writePrivate(
      resolve(outputRoot, "villefer-v1.agent-package.json"),
      stableJson(artifacts.package)
    ),
    writePrivate(
      resolve(outputRoot, "villefer-v1.evaluation-suite.json"),
      stableJson(artifacts.evaluationSuite)
    ),
    writePrivate(
      resolve(outputRoot, "villefer-v1.evidence.json"),
      stableJson(artifacts.evidence)
    ),
    writePrivate(
      resolve(outputRoot, "villefer-v1-review.md"),
      artifacts.reviewMarkdown
    )
  ]);

  process.stdout.write(
    [
      "Villefer V1 compilation completed.",
      `Instances: ${artifacts.evidence.overall.instances}`,
      `Messages reconciled: ${artifacts.evidence.overall.sourceMessages}`,
      `Commercial journeys: ${artifacts.evidence.overall.commercialJourneys}`,
      `Evaluation cases: ${artifacts.evaluationSuite.cases.length}`,
      `Output: ${outputRoot}`
    ].join("\n") + "\n"
  );
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown compilation failure."}\n`
  );
  process.exitCode = 1;
});
