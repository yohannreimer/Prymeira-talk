# Talk-Origin Vincula Demo Portfolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the neutral Vincula demo portfolio with nine contacts genuinely shared with Talk, six historical deals, and Carlos Mendes reserved for the live tenth-contact synchronization.

**Architecture:** Define the Vincula portfolio as exported deterministic data and let the reset seed persist it transactionally. Define the Talk-side cross-application ID map separately, use it while creating contacts and real CRM history, then verify both databases through the existing coordinated reset and local stack.

**Tech Stack:** Node.js, TypeScript, PostgreSQL, Fastify, Prisma, React, Vitest, Node test runner, shell orchestration, in-app browser.

---

### Task 1: Model the Talk-Origin Portfolio in Vincula

**Files:**
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-portfolio.js`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-portfolio.test.mjs`

- [ ] **Step 1: Write the failing portfolio test**

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_DEMO_COMPANIES,
  LOCAL_DEMO_CONTACTS,
  LOCAL_DEMO_DEALS,
  LOCAL_DEMO_DEAL_NOTES,
} from "./local-demo-portfolio.js";

test("portfolio mirrors nine Talk contacts and six staged deals", () => {
  assert.equal(LOCAL_DEMO_COMPANIES.length, 9);
  assert.equal(LOCAL_DEMO_CONTACTS.length, 9);
  assert.equal(LOCAL_DEMO_DEALS.length, 6);
  assert.equal(LOCAL_DEMO_DEAL_NOTES.length, 6);
  assert.deepEqual(
    LOCAL_DEMO_CONTACTS.map(({ firstName, lastName }) => `${firstName} ${lastName}`),
    [
      "Ana Beatriz",
      "João Martins",
      "Camila Rocha",
      "Pedro Almeida",
      "Larissa Gomes",
      "Marcelo Souza",
      "Renata Vieira",
      "Bruno Tavares",
      "Paula Freitas",
    ],
  );
  assert.equal(LOCAL_DEMO_CONTACTS.some(({ firstName }) => firstName === "Carlos"), false);
  assert.deepEqual(
    new Set(LOCAL_DEMO_DEALS.map(({ stage }) => stage)),
    new Set(["opportunity", "proposal-sent", "in-negociation", "won", "lost"]),
  );
  assert.equal(LOCAL_DEMO_DEALS.every(({ source }) => source === "Prymeira Talk"), true);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

```sh
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run test:server
```

Expected: FAIL because `local-demo-portfolio.js` does not exist.

- [ ] **Step 3: Add the deterministic portfolio data**

Create `local-demo-portfolio.js` with the exact records below. Keep monetary amounts in integer BRL units, matching the current schema.

```js
export const LOCAL_DEMO_COMPANIES = [
  { id: 9301, name: "Clínica Aurora", sector: "Saúde", size: 48, city: "Joinville", state: "SC", salesId: 9101, description: "Nova unidade em fase de implantação." },
  { id: 9302, name: "JM Auto Peças", sector: "Automotivo", size: 35, city: "Porto Alegre", state: "RS", salesId: 9102, description: "Cliente de reposição e suporte logístico." },
  { id: 9303, name: "Studio Rocha", sector: "Arquitetura", size: 22, city: "São Paulo", state: "SP", salesId: 9103, description: "Conta recorrente com demanda por volume." },
  { id: 9304, name: "Almeida Energia", sector: "Energia", size: 76, city: "Florianópolis", state: "SC", salesId: 9102, description: "Conta atendida pelo financeiro e pós-venda." },
  { id: 9305, name: "Gomes Moda", sector: "Varejo", size: 18, city: "Belo Horizonte", state: "MG", salesId: 9104, description: "Renovação de fornecimento em acompanhamento." },
  { id: 9306, name: "Souza Manutenção", sector: "Serviços industriais", size: 41, city: "Curitiba", state: "PR", salesId: 9105, description: "Operação regional em qualificação." },
  { id: 9307, name: "Vieira Engenharia", sector: "Engenharia", size: 63, city: "São Paulo", state: "SP", salesId: 9101, description: "Fornecimento empresarial concluído." },
  { id: 9308, name: "Tavares Obras", sector: "Construção", size: 52, city: "Belo Horizonte", state: "MG", salesId: 9104, description: "Projeto pausado após análise financeira." },
  { id: 9309, name: "Freitas Logística", sector: "Logística", size: 95, city: "Brasília", state: "DF", salesId: 9103, description: "Conta ativa em atendimento de pós-venda." },
];

export const LOCAL_DEMO_CONTACTS = [
  { id: 9401, companyId: 9301, firstName: "Ana", lastName: "Beatriz", title: "Gerente de Operações", salesId: 9101, email: "ana@clinicaaurora.com.br", phone: "5547999910101" },
  { id: 9402, companyId: 9302, firstName: "João", lastName: "Martins", title: "Gerente de Compras", salesId: 9102, email: "compras@jmautopecas.com.br", phone: "5551999820202" },
  { id: 9403, companyId: 9303, firstName: "Camila", lastName: "Rocha", title: "Diretora de Projetos", salesId: 9103, email: "camila@studiorocha.com.br", phone: "5511999730303" },
  { id: 9404, companyId: 9304, firstName: "Pedro", lastName: "Almeida", title: "Responsável Financeiro", salesId: 9102, email: "financeiro@almeidaenergia.com.br", phone: "5548999640404" },
  { id: 9405, companyId: 9305, firstName: "Larissa", lastName: "Gomes", title: "Diretora Comercial", salesId: 9104, email: "larissa@gomesmoda.com.br", phone: "5531999550505" },
  { id: 9406, companyId: 9306, firstName: "Marcelo", lastName: "Souza", title: "Gestor de Manutenção", salesId: 9105, email: "marcelo@souzamanutencao.com.br", phone: "5541999460606" },
  { id: 9407, companyId: 9307, firstName: "Renata", lastName: "Vieira", title: "Diretora de Engenharia", salesId: 9101, email: "renata@vieiraengenharia.com.br", phone: "5511999370707" },
  { id: 9408, companyId: 9308, firstName: "Bruno", lastName: "Tavares", title: "Diretor de Obras", salesId: 9104, email: "bruno@tavaresobras.com.br", phone: "5531999280808" },
  { id: 9409, companyId: 9309, firstName: "Paula", lastName: "Freitas", title: "Gerente de Logística", salesId: 9103, email: "paula@freitaslogistica.com.br", phone: "5561999190909" },
];

export const LOCAL_DEMO_DEALS = [
  { id: 9501, name: "Fornecimento regional Souza", companyId: 9306, contactId: 9406, category: "Fornecimento", stage: "opportunity", amount: 24000, salesId: 9105, probability: 35, source: "Prymeira Talk", lostReason: null },
  { id: 9502, name: "Nova unidade Clínica Aurora", companyId: 9301, contactId: 9401, category: "Implantação", stage: "proposal-sent", amount: 68000, salesId: 9101, probability: 60, source: "Prymeira Talk", lostReason: null },
  { id: 9503, name: "Renovação Gomes Moda", companyId: 9305, contactId: 9405, category: "Renovação", stage: "proposal-sent", amount: 32000, salesId: 9104, probability: 55, source: "Prymeira Talk", lostReason: null },
  { id: 9504, name: "Contrato recorrente Studio Rocha", companyId: 9303, contactId: 9403, category: "Contrato", stage: "in-negociation", amount: 92000, salesId: 9103, probability: 80, source: "Prymeira Talk", lostReason: null },
  { id: 9505, name: "Fornecimento Vieira Engenharia", companyId: 9307, contactId: 9407, category: "Fornecimento", stage: "won", amount: 54000, salesId: 9101, probability: 100, source: "Prymeira Talk", lostReason: null },
  { id: 9506, name: "Projeto Tavares Obras", companyId: 9308, contactId: 9408, category: "Projeto", stage: "lost", amount: 38000, salesId: 9104, probability: 0, source: "Prymeira Talk", lostReason: "Projeto pausado após validação financeira" },
];

export const LOCAL_DEMO_DEAL_NOTES = [
  { id: 9601, dealId: 9501, salesId: 9105, text: "Região e prazo de entrega em qualificação." },
  { id: 9602, dealId: 9502, salesId: 9101, text: "Proposta preparada para equipar a nova unidade." },
  { id: 9603, dealId: 9503, salesId: 9104, text: "Condição recorrente enviada e aguardando retorno." },
  { id: 9604, dealId: 9504, salesId: 9103, text: "Condições por volume e agenda comercial em negociação." },
  { id: 9605, dealId: 9505, salesId: 9101, text: "Fornecimento aprovado e concluído." },
  { id: 9606, dealId: 9506, salesId: 9104, text: "Projeto pausado após validação financeira." },
];
```

- [ ] **Step 4: Run the portfolio test**

Run the same `npm run test:server` command.

Expected: all server tests PASS, including the new portfolio test.

- [ ] **Step 5: Commit the portfolio model**

```sh
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" add server/local-demo-portfolio.js server/local-demo-portfolio.test.mjs
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" commit -m "feat: model Talk-origin demo portfolio"
```

---

### Task 2: Seed the Vincula Portfolio Transactionally

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-seed.js`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM/server/local-demo-seed.test.mjs`

- [ ] **Step 1: Update the seed test first**

Change the expected reset result and add assertions for shared names and old-name removal:

```js
assert.deepEqual(result, {
  ok: true,
  workspaceId,
  sales: 5,
  companies: 9,
  contacts: 9,
  deals: 6,
  notes: 6,
});
assert.ok(client.calls.some(({ params }) => params?.includes("Clínica Aurora")));
assert.ok(client.calls.some(({ params }) => params?.includes("Ana")));
assert.equal(client.calls.some(({ params }) => params?.includes("Atlas Facilities")), false);
```

- [ ] **Step 2: Run the test and verify the old counts fail**

```sh
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run test:server
```

Expected: FAIL because the seed still returns four companies, contacts, deals, and notes.

- [ ] **Step 3: Replace the neutral inserts with portfolio loops**

Import the four arrays and replace the existing company, contact, deal, and note SQL blocks with parameterized loops:

```js
import {
  LOCAL_DEMO_COMPANIES,
  LOCAL_DEMO_CONTACTS,
  LOCAL_DEMO_DEALS,
  LOCAL_DEMO_DEAL_NOTES,
} from "./local-demo-portfolio.js";

for (const company of LOCAL_DEMO_COMPANIES) {
  await client.query(
    `insert into public.companies
      (id, workspace_id, name, sector, size, city, state_abbr, sales_id, description)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [company.id, workspaceId, company.name, company.sector, company.size, company.city, company.state, company.salesId, company.description],
  );
}

for (const contact of LOCAL_DEMO_CONTACTS) {
  await client.query(
    `insert into public.contacts
      (id, workspace_id, first_name, last_name, title, status, company_id,
       sales_id, email_jsonb, phone_jsonb)
     values ($1, $2, $3, $4, $5, 'active', $6, $7, $8::jsonb, $9::jsonb)`,
    [contact.id, workspaceId, contact.firstName, contact.lastName, contact.title, contact.companyId, contact.salesId, JSON.stringify([{ email: contact.email, type: "Work" }]), JSON.stringify([{ number: contact.phone, type: "Work" }])],
  );
}

for (const deal of LOCAL_DEMO_DEALS) {
  await client.query(
    `insert into public.deals
      (id, workspace_id, name, company_id, contact_ids, category, stage,
       description, amount, sales_id, index, deal_type, probability, source,
       pipeline_id, lost_reason)
     values ($1, $2, $3, $4, array[$5]::bigint[], $6, $7, $8, $9, $10,
       0, 'consultative', $11, $12, $13, $14)`,
    [deal.id, workspaceId, deal.name, deal.companyId, deal.contactId, deal.category, deal.stage, `Negócio originado do atendimento de ${deal.name}.`, deal.amount, deal.salesId, deal.probability, deal.source, LOCAL_DEMO_PIPELINE_ID, deal.lostReason],
  );
}

for (const note of LOCAL_DEMO_DEAL_NOTES) {
  await client.query(
    `insert into public.deal_notes
      (id, workspace_id, deal_id, type, text, sales_id)
     values ($1, $2, $3, 'note', $4, $5)`,
    [note.id, workspaceId, note.dealId, note.text, note.salesId],
  );
}
```

Return the array lengths instead of hard-coded counts:

```js
return {
  ok: true,
  workspaceId,
  sales: LOCAL_DEMO_SALE_IDS.length,
  companies: LOCAL_DEMO_COMPANIES.length,
  contacts: LOCAL_DEMO_CONTACTS.length,
  deals: LOCAL_DEMO_DEALS.length,
  notes: LOCAL_DEMO_DEAL_NOTES.length,
};
```

Keep the existing sequence `setval` call so Carlos receives company `9310`, contact `9410`, deal `9507`, and subsequent note IDs.

- [ ] **Step 4: Run server tests and typecheck**

```sh
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run test:server
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run typecheck
```

Expected: all server tests PASS and typecheck exits `0`.

- [ ] **Step 5: Commit the seed integration**

```sh
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" add server/local-demo-seed.js server/local-demo-seed.test.mjs
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" commit -m "feat: seed Talk-origin Vincula portfolio"
```

---

### Task 3: Define Talk-to-Vincula Fixed Links and History

**Files:**
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo-vincula-portfolio.ts`
- Create: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo-vincula-portfolio.test.ts`

- [ ] **Step 1: Write a failing pure-data test**

```ts
import { describe, expect, it } from "vitest";
import {
  DEMO_VINCULA_LINKS,
  buildDemoVinculaSyncActions
} from "./demo-vincula-portfolio.js";

describe("Talk-origin Vincula portfolio", () => {
  it("links nine existing contacts while reserving Carlos for the live sync", () => {
    expect(Object.keys(DEMO_VINCULA_LINKS)).toHaveLength(9);
    expect(DEMO_VINCULA_LINKS["60000000-0000-4000-8000-000000000010"]).toBeUndefined();
    expect(DEMO_VINCULA_LINKS["60000000-0000-4000-8000-000000000001"]).toMatchObject({
      companyId: "9301",
      contactId: "9401",
      dealId: "9502",
      noteId: "9602"
    });
  });

  it("builds six real completed synchronization actions", () => {
    const actions = buildDemoVinculaSyncActions("demo_workspace");
    expect(actions).toHaveLength(6);
    expect(actions.every((action) => action.mode === "real" && action.status === "completed")).toBe(true);
    expect(actions.every((action) => String(action.result.vinculaRecordUrl).includes("/#/deals/"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

```sh
pnpm --dir "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk" --filter @prymeira-talk/api test -- src/modules/demo/demo-vincula-portfolio.test.ts
```

Expected: FAIL because `demo-vincula-portfolio.ts` does not exist.

- [ ] **Step 3: Implement the fixed link map and history builder**

```ts
type DemoVinculaLink = {
  companyId: string;
  contactId: string;
  dealId?: string;
  noteId?: string;
  title?: string;
};

export const DEMO_VINCULA_LINKS: Record<string, DemoVinculaLink> = {
  "60000000-0000-4000-8000-000000000001": { companyId: "9301", contactId: "9401", dealId: "9502", noteId: "9602", title: "Nova unidade Clínica Aurora" },
  "60000000-0000-4000-8000-000000000002": { companyId: "9302", contactId: "9402" },
  "60000000-0000-4000-8000-000000000003": { companyId: "9303", contactId: "9403", dealId: "9504", noteId: "9604", title: "Contrato recorrente Studio Rocha" },
  "60000000-0000-4000-8000-000000000004": { companyId: "9304", contactId: "9404" },
  "60000000-0000-4000-8000-000000000005": { companyId: "9305", contactId: "9405", dealId: "9503", noteId: "9603", title: "Renovação Gomes Moda" },
  "60000000-0000-4000-8000-000000000006": { companyId: "9306", contactId: "9406", dealId: "9501", noteId: "9601", title: "Fornecimento regional Souza" },
  "60000000-0000-4000-8000-000000000007": { companyId: "9307", contactId: "9407", dealId: "9505", noteId: "9605", title: "Fornecimento Vieira Engenharia" },
  "60000000-0000-4000-8000-000000000008": { companyId: "9308", contactId: "9408", dealId: "9506", noteId: "9606", title: "Projeto Tavares Obras" },
  "60000000-0000-4000-8000-000000000009": { companyId: "9309", contactId: "9409" },
};

export function buildDemoVinculaSyncActions(workspaceId: string) {
  return Object.entries(DEMO_VINCULA_LINKS)
    .filter((entry): entry is [string, DemoVinculaLink & Required<Pick<DemoVinculaLink, "dealId" | "noteId" | "title">>] => Boolean(entry[1].dealId && entry[1].noteId && entry[1].title))
    .map(([contactId, link]) => ({
      workspaceId,
      contactId,
      actionType: "create_lead" as const,
      mode: "real" as const,
      status: "completed" as const,
      payload: {
        title: link.title,
        provider: "vincula",
        contactId,
        vinculaDealId: link.dealId,
        vinculaCompanyId: link.companyId,
        vinculaContactId: link.contactId
      },
      result: {
        mode: "real",
        dealCreated: true,
        dealUpdated: false,
        environment: "local-demo",
        vinculaDealId: link.dealId,
        vinculaNoteId: link.noteId,
        vinculaCompanyId: link.companyId,
        vinculaContactId: link.contactId,
        vinculaRecordUrl: `http://localhost:5174/#/deals/${link.dealId}/show`
      }
    }));
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run the focused Vitest command, then:

```sh
pnpm --dir "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk" --filter @prymeira-talk/api typecheck
```

Expected: two new tests PASS and typecheck exits `0`.

- [ ] **Step 5: Commit the Talk portfolio contract**

```sh
git add apps/api/src/modules/demo/demo-vincula-portfolio.ts apps/api/src/modules/demo/demo-vincula-portfolio.test.ts
git commit -m "feat: define Talk Vincula demo links"
```

---

### Task 4: Wire Real Vincula Links into the Talk Seed

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo-scenario.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo-scenario.test.ts`

- [ ] **Step 1: Add a regression test for link lookup behavior**

Extend `demo-scenario.test.ts` with a pure assertion exported through a small helper:

```ts
import { readDemoVinculaLink } from "./demo-scenario.js";

it("returns fixed links for existing Talk contacts but not Carlos", () => {
  expect(readDemoVinculaLink("60000000-0000-4000-8000-000000000001")).toMatchObject({
    contactId: "9401",
    dealId: "9502"
  });
  expect(readDemoVinculaLink("60000000-0000-4000-8000-000000000010")).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify `readDemoVinculaLink` is missing**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/demo/demo-scenario.test.ts
```

Expected: FAIL because `readDemoVinculaLink` is not exported.

- [ ] **Step 3: Apply links while creating Talk contacts**

Import the portfolio module and add the helper:

```ts
import {
  DEMO_VINCULA_LINKS,
  buildDemoVinculaSyncActions
} from "./demo-vincula-portfolio.js";

export function readDemoVinculaLink(contactId: string) {
  return DEMO_VINCULA_LINKS[contactId] ?? null;
}
```

Inside the contact loop, set the native link fields:

```ts
const vinculaLink = readDemoVinculaLink(seed.contactId);
await prisma.contact.create({
  data: {
    id: seed.contactId,
    workspaceId,
    name: seed.name,
    phone: seed.phone,
    email: seed.email,
    company: seed.company,
    customFields: { origem: "WhatsApp", segmento: "B2B" },
    atomicCrmContactId: vinculaLink?.contactId,
    atomicCrmLeadId: vinculaLink?.dealId
  }
});
```

Switch the integration record and history to the local-real contract:

```ts
await prisma.integrationConfig.create({
  data: {
    workspaceId,
    provider: "vincula",
    mode: "real",
    status: "configured",
    settings: { label: "Vincula CRM local", fallbackEnabled: true }
  }
});
await prisma.crmSyncAction.createMany({
  data: buildDemoVinculaSyncActions(workspaceId)
});
```

Delete the two old hard-coded simulated actions.

- [ ] **Step 4: Run demo tests and API typecheck**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/demo/demo-vincula-portfolio.test.ts src/modules/demo/demo-scenario.test.ts src/modules/crm/crm.service.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: focused tests PASS and typecheck exits `0`.

- [ ] **Step 5: Commit the seeded cross-links**

```sh
git add apps/api/src/modules/demo/demo-scenario.ts apps/api/src/modules/demo/demo-scenario.test.ts
git commit -m "feat: seed real Vincula links in Talk"
```

---

### Task 5: Update Reset Contracts and Demo Messaging

**Files:**
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/demo.routes.test.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/apps/api/src/modules/demo/vincula-demo-client.test.ts`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/scripts/reset-integrated-demo.sh`
- Modify: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/docs/demo-runbook.md`

- [ ] **Step 1: Update test fixtures to the new Vincula baseline**

Use this fixture in both API test files:

```ts
const vinculaResult = {
  ok: true,
  workspaceId: "70000000-0000-4000-8000-000000000001",
  sales: 5,
  companies: 9,
  contacts: 9,
  deals: 6,
  notes: 6
};
```

Change the client assertion to `expect.objectContaining({ ok: true, sales: 5, contacts: 9, deals: 6 })`.

- [ ] **Step 2: Run the reset tests**

```sh
pnpm --filter @prymeira-talk/api test -- src/modules/demo/vincula-demo-client.test.ts src/modules/demo/demo.routes.test.ts
```

Expected: PASS with the new baseline contract.

- [ ] **Step 3: Update terminal and runbook copy**

The reset script must print:

```sh
printf '%s\n' "Demo integrada restaurada: Talk com 10 conversas; Vincula com 9 contatos e 6 negócios."
```

Update the runbook checklist and reset section to state:

```text
Antes da criação ao vivo, o Vincula mostra nove contatos originados no Talk e seis negócios históricos. Carlos Mendes aparece somente depois da sincronização.
```

- [ ] **Step 4: Verify shell syntax and focused tests**

```sh
sh -n scripts/reset-integrated-demo.sh
pnpm --filter @prymeira-talk/api test -- src/modules/demo/vincula-demo-client.test.ts src/modules/demo/demo.routes.test.ts
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit contract and documentation updates**

```sh
git add apps/api/src/modules/demo/demo.routes.test.ts apps/api/src/modules/demo/vincula-demo-client.test.ts scripts/reset-integrated-demo.sh docs/demo-runbook.md
git commit -m "docs: align demo reset with Talk portfolio"
```

---

### Task 6: Verify the Shared Baseline and Live Carlos Flow

**Files:**
- Runtime only: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo`

- [ ] **Step 1: Stop the owned stack and reset both databases**

Stop the active `pnpm demo:stack` terminal with `Ctrl+C`, then run:

```sh
pnpm demo:reset:all
```

Expected: the terminal confirms 10 Talk conversations, 9 Vincula contacts, and 6 Vincula deals.

- [ ] **Step 2: Verify the database cross-links before starting the UI**

```sh
/opt/homebrew/bin/psql postgresql://postgres@127.0.0.1:54329/prymeira_talk -AtF '|' -c "
  select count(*) from contacts where workspace_id='demo_workspace';
  select count(*) from contacts where workspace_id='demo_workspace' and atomic_crm_contact_id is not null;
  select count(*) from contacts where workspace_id='demo_workspace' and atomic_crm_lead_id is not null;
  select atomic_crm_contact_id, atomic_crm_lead_id from contacts where id='60000000-0000-4000-8000-000000000010';
  select count(*) from crm_sync_actions where workspace_id='demo_workspace' and mode='real' and status='completed';
"
/opt/homebrew/bin/psql postgresql://postgres@127.0.0.1:54329/prymeira_vincula_demo -AtF '|' -c "
  select count(*) from companies where workspace_id='70000000-0000-4000-8000-000000000001';
  select count(*) from contacts where workspace_id='70000000-0000-4000-8000-000000000001';
  select count(*) from deals where workspace_id='70000000-0000-4000-8000-000000000001';
  select count(*) from contacts where first_name='Carlos' and last_name='Mendes';
"
```

Expected Talk rows: `10`, `9`, `6`, `|`, `6`. Expected Vincula rows: `9`, `9`, `6`, `0`.

Export the nine shared identities from each database and compare them byte-for-byte:

```sh
runtime_dir="/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo"
talk_contacts="$runtime_dir/talk-shared-contacts.txt"
vincula_contacts="$runtime_dir/vincula-shared-contacts.txt"

/opt/homebrew/bin/psql postgresql://postgres@127.0.0.1:54329/prymeira_talk -AtF '|' -c "
  select name, phone, email, company
  from contacts
  where workspace_id='demo_workspace'
    and id <> '60000000-0000-4000-8000-000000000010'
  order by name;
" > "$talk_contacts"
/opt/homebrew/bin/psql postgresql://postgres@127.0.0.1:54329/prymeira_vincula_demo -AtF '|' -c "
  select concat(contact.first_name, ' ', contact.last_name),
         contact.phone_jsonb->0->>'number',
         contact.email_jsonb->0->>'email',
         company.name
  from contacts contact
  join companies company
    on company.workspace_id = contact.workspace_id
   and company.id = contact.company_id
  where contact.workspace_id='70000000-0000-4000-8000-000000000001'
  order by 1;
" > "$vincula_contacts"
diff -u "$talk_contacts" "$vincula_contacts"
```

Expected: `diff` exits `0` with no output, proving name, phone, email, and company match across the two local products. Both temporary reports remain on the SSD.

- [ ] **Step 3: Start the stack and run its health check**

```sh
pnpm demo:stack
```

In another terminal:

```sh
pnpm demo:check
```

Expected: all four services healthy and databases on the SSD.

- [ ] **Step 4: Exercise Carlos through the API and verify idempotency**

Call `POST /crm/create-lead` twice for Carlos with the local Talk bypass token:

```sh
curl -fsS -X POST \
  -H 'Authorization: Bearer local-dev-bypass' \
  -H 'Content-Type: application/json' \
  --data '{"contactId":"60000000-0000-4000-8000-000000000010","title":"Construtora Horizonte — Nova oportunidade"}' \
  http://localhost:3002/crm/create-lead
curl -fsS -X POST \
  -H 'Authorization: Bearer local-dev-bypass' \
  -H 'Content-Type: application/json' \
  --data '{"contactId":"60000000-0000-4000-8000-000000000010","title":"Construtora Horizonte — Nova oportunidade"}' \
  http://localhost:3002/crm/create-lead
```

Then query Vincula:

```sh
/opt/homebrew/bin/psql postgresql://postgres@127.0.0.1:54329/prymeira_vincula_demo -AtF '|' -c "
  select count(*) from contacts where workspace_id='70000000-0000-4000-8000-000000000001';
  select count(*) from contacts where first_name='Carlos' and last_name='Mendes';
  select count(*) from companies where name='Construtora Horizonte';
  select count(*) from deals where source='Prymeira Talk' and contact_ids @> array[9410]::bigint[];
"
```

Expected: `10`, `1`, `1`, `1`. The first call returns deal `9507`; the second reuses `9507`.

- [ ] **Step 5: Restore the baseline again**

Call `POST /demo/reset` through Talk or run `pnpm demo:reset:all`, then repeat the counts from Step 2.

Expected: Carlos is removed from Vincula and the exact `9/9/6` baseline returns.

---

### Task 7: Browser-Validate the Presentation Story and Run Full Verification

**Files:**
- Modify only if browser evidence requires copy correction: `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/docs/demo-runbook.md`

- [ ] **Step 1: Validate the initial Vincula Contacts page at 1440 × 900**

Open `http://localhost:5174/#/contacts` and verify the list contains all nine Talk people, contains no Atlas/Lumina/Vértice/Nexo records, and does not contain Carlos Mendes.

Expected visible names: Ana Beatriz, João Martins, Camila Rocha, Pedro Almeida, Larissa Gomes, Marcelo Souza, Renata Vieira, Bruno Tavares, Paula Freitas.

- [ ] **Step 2: Validate the initial Kanban**

Open `http://localhost:5174/#/deals` and verify six cards across Oportunidade, Proposta enviada, Em negociação, Ganho, and Perdido. Every opened deal must show origin **Prymeira Talk**.

- [ ] **Step 3: Validate the live tenth-contact reveal**

In Talk, simulate Carlos, open **Vincula CRM**, click **Criar oportunidade**, and then **Abrir no Vincula**.

Expected: IDs `9310`, `9410`, and `9507`; the Vincula dialog shows Carlos Mendes, Construtora Horizonte, source Prymeira Talk, 75% probability, and the initial integration note.

- [ ] **Step 4: Validate AI note and coordinated reset**

Send the AI note in Talk, reload the Vincula dialog, and verify the second note. Click **Restaurar** in Talk and verify the integrated success notice; refresh Vincula and confirm Carlos disappeared.

- [ ] **Step 5: Run full verification in both repositories**

```sh
runtime_dir="/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local/integrated-demo"
export TMPDIR="$runtime_dir/tmp"
export XDG_CACHE_HOME="$runtime_dir/cache"
export PLAYWRIGHT_BROWSERS_PATH="$runtime_dir/playwright"
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$PLAYWRIGHT_BROWSERS_PATH"

pnpm test
pnpm typecheck
pnpm build
pnpm demo:check

npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run test:server
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run test:unit:app -- --run
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run test:unit:functions -- --run
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run typecheck
npm --prefix "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" run build
```

Expected: all tests, typechecks, builds, and health checks exit `0`.

- [ ] **Step 6: Final repository audit**

```sh
git status --short
git -C "/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Vincula CRM" status --short
```

Expected: Vincula is clean; Talk contains only the user's pre-existing `.DS_Store` and `tmp/` untracked entries. Runtime files remain below `/Volumes/SanDiskSSD/Projetos/Locais/Prymeira/Prymeira Talk/.local`.
