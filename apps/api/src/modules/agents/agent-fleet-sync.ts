// Plans (never applies) a sync of one "master" agent across the same agent deployed in
// several workspaces. Each workspace keeps its own deployment variables (e.g. seller_name):
// only the prompt template and the approved knowledge are propagated, then re-rendered per workspace.

export type FleetKnowledge = {
  id: string;
  type: string;
  title: string;
  content: string | null;
  metadata: Record<string, unknown>;
};

export type FleetAgent = {
  workspaceId: string;
  id: string;
  name: string;
  systemPrompt: string;
  behaviorConfig: Record<string, unknown>;
  knowledge: FleetKnowledge[];
};

export type NewKnowledgeEntry = {
  key: string;
  type: "text" | "faq";
  title: string;
  content: string;
  category: string;
  aliases: string[];
  source: string;
};

export type TextFix = { from: RegExp; to: string; label: string };

export type KnowledgeCreate = {
  key: string;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
};

export type KnowledgeUpdate = {
  id: string;
  title: string;
  before: string;
  after: string;
  metadata: Record<string, unknown>;
};

export type TargetPlan = {
  workspaceId: string;
  agentId: string;
  agentName: string;
  prompt: { changed: boolean; before: string; after: string };
  template: { changed: boolean; before: string; after: string };
  knowledgeUpdates: KnowledgeUpdate[];
  knowledgeCreates: KnowledgeCreate[];
  errors: string[];
};

export type FleetSyncPlan = { sourceWorkspaceId: string; targets: TargetPlan[]; errors: string[] };

export function renderTemplate(value: string, variables: Record<string, string>) {
  return value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, key: string) => variables[key] ?? "");
}

export function templateVariables(value: string) {
  return Array.from(new Set(Array.from(value.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g), (match) => match[1])));
}

export function applyFixes(value: string, fixes: TextFix[]) {
  return fixes.reduce((text, fix) => text.replace(fix.from, fix.to), value);
}

// A master text may spell the master's own deployment value literally (e.g. "Junior").
// Copying it as-is would make every other seller say "Junior", so turn it back into its variable.
export function templatize(value: string, variables: Record<string, string>) {
  return Object.entries(variables).reduce((text, [key, raw]) => {
    const literal = raw.trim();
    if (literal.length < 3) return text;
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`(?<!\\{\\{)${escaped}(?![a-zA-Z0-9_]*\\}\\})`, "g"), `{{${key}}}`);
  }, value);
}

export function lineDiff(before: string, after: string) {
  const oldLines = before.split("\n").map((line) => line.trim()).filter(Boolean);
  const newLines = after.split("\n").map((line) => line.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    removed: oldLines.filter((line) => !newSet.has(line)),
    added: newLines.filter((line) => !oldSet.has(line))
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringVariables(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function knowledgeKey(item: FleetKnowledge) {
  const key = item.metadata.packageKnowledgeKey;
  return typeof key === "string" && key ? key : null;
}

function findKnowledge(agent: FleetAgent, key: string | null, title: string) {
  return (
    (key ? agent.knowledge.find((item) => knowledgeKey(item) === key) : undefined) ??
    agent.knowledge.find((item) => item.title.trim().toLowerCase() === title.trim().toLowerCase())
  );
}

export function planFleetSync(input: {
  source: FleetAgent;
  targets: FleetAgent[];
  newKnowledge: NewKnowledgeEntry[];
  fixes: TextFix[];
  approvedBy: string;
  approvedAt: string;
}): FleetSyncPlan {
  const errors: string[] = [];
  const sourceBehavior = record(input.source.behaviorConfig);
  const sourceTemplate = typeof sourceBehavior.packagePromptTemplate === "string" ? sourceBehavior.packagePromptTemplate : null;
  const sourceVars = stringVariables(sourceBehavior.deploymentVariables);
  if (!sourceTemplate) {
    return { sourceWorkspaceId: input.source.workspaceId, targets: [], errors: ["Source agent has no packagePromptTemplate."] };
  }
  if (renderTemplate(sourceTemplate, sourceVars).trim() !== input.source.systemPrompt.trim()) {
    errors.push("Source prompt does not equal its template rendered with its variables; refusing to sync.");
  }
  const masterTemplate = templatize(applyFixes(sourceTemplate, input.fixes), sourceVars);

  const masterKnowledge = input.source.knowledge.map((item) => ({
    item,
    key: knowledgeKey(item),
    template: templatize(
      applyFixes(
        typeof item.metadata.packageContentTemplate === "string" ? item.metadata.packageContentTemplate : item.content ?? "",
        input.fixes
      ),
      sourceVars
    )
  }));

  const targets = input.targets.map((target): TargetPlan => {
    const targetErrors: string[] = [];
    const behavior = record(target.behaviorConfig);
    const currentTemplate = typeof behavior.packagePromptTemplate === "string" ? behavior.packagePromptTemplate : "";
    const vars = stringVariables(behavior.deploymentVariables);

    if (!currentTemplate) targetErrors.push("Target has no packagePromptTemplate.");
    else if (renderTemplate(currentTemplate, vars).trim() !== target.systemPrompt.trim()) {
      targetErrors.push("Target prompt does not equal its template rendered with its variables; refusing to touch it.");
    }
    const missing = templateVariables(masterTemplate).filter((name) => !vars[name]);
    if (missing.length > 0) targetErrors.push(`Target is missing deployment variables: ${missing.join(", ")}.`);

    const nextPrompt = renderTemplate(masterTemplate, vars).trim();
    const knowledgeUpdates: KnowledgeUpdate[] = [];
    const knowledgeCreates: KnowledgeCreate[] = [];

    for (const master of masterKnowledge) {
      const existing = findKnowledge(target, master.key, master.item.title);
      const rendered = renderTemplate(master.template, vars).trim();
      if (!existing) {
        knowledgeCreates.push({
          key: master.key ?? master.item.title,
          type: master.item.type,
          title: master.item.title,
          content: rendered,
          metadata: { ...master.item.metadata, packageContentTemplate: master.template }
        });
      } else if ((existing.content ?? "").trim() !== rendered) {
        knowledgeUpdates.push({
          id: existing.id,
          title: existing.title,
          before: existing.content ?? "",
          after: rendered,
          metadata: { ...existing.metadata, packageContentTemplate: master.template }
        });
      }
    }

    for (const entry of input.newKnowledge) {
      const existing = findKnowledge(target, entry.key, entry.title);
      const metadata = {
        category: entry.category,
        aliases: entry.aliases,
        approvalStatus: "confirmed",
        source: entry.source,
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt,
        validUntil: null,
        packageKnowledgeKey: entry.key,
        packageContentTemplate: entry.content
      };
      if (!existing) {
        knowledgeCreates.push({ key: entry.key, type: entry.type, title: entry.title, content: entry.content, metadata });
      } else if ((existing.content ?? "").trim() !== entry.content.trim()) {
        knowledgeUpdates.push({
          id: existing.id,
          title: existing.title,
          before: existing.content ?? "",
          after: entry.content,
          metadata: { ...existing.metadata, ...metadata }
        });
      }
    }

    return {
      workspaceId: target.workspaceId,
      agentId: target.id,
      agentName: target.name,
      prompt: { changed: nextPrompt !== target.systemPrompt.trim(), before: target.systemPrompt, after: nextPrompt },
      template: { changed: masterTemplate !== currentTemplate, before: currentTemplate, after: masterTemplate },
      knowledgeUpdates,
      knowledgeCreates,
      errors: targetErrors
    };
  });

  return { sourceWorkspaceId: input.source.workspaceId, targets, errors };
}

export function planHasChanges(plan: FleetSyncPlan) {
  return plan.targets.some(
    (target) => target.prompt.changed || target.template.changed || target.knowledgeUpdates.length > 0 || target.knowledgeCreates.length > 0
  );
}

export function planHasErrors(plan: FleetSyncPlan) {
  return plan.errors.length > 0 || plan.targets.some((target) => target.errors.length > 0);
}
