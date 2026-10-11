import { describe, expect, it } from "vitest";
import {
  automationBlockCatalog,
  automationFlowSchema,
  findWebhookTriggerNode,
  getAutomationBlock,
  readWebhookTriggerChannelId,
  validateAutomationFlowForStatus
} from "./automation-flow";
import { automationWebhookPath, automationWebhookSchema } from "./automation-webhook";

describe("automation flow contract", () => {
  it("contains the first-cut supported blocks", () => {
    expect(getAutomationBlock("trigger_first_message")?.support).toBe("supported");
    expect(getAutomationBlock("trigger_message_received")?.support).toBe("supported");
    expect(getAutomationBlock("send_message")?.support).toBe("supported");
    expect(getAutomationBlock("send_file")?.support).toBe("supported");
    expect(getAutomationBlock("add_tag")?.support).toBe("supported");
    expect(getAutomationBlock("move_board_stage")?.support).toBe("supported");
    expect(getAutomationBlock("ai_classify_message")?.support).toBe("coming_soon");
  });

  it("parses a valid versioned flow", () => {
    const flow = automationFlowSchema.parse({
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_first_message",
          position: { x: 0, y: 0 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: "message-1",
          type: "send_message",
          position: { x: 260, y: 0 },
          data: { title: "Enviar mensagem", config: { text: "Olá!" } }
        }
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "message-1" }]
    });

    expect(flow.version).toBe(1);
    expect(flow.nodes).toHaveLength(2);
  });

  it("parses nullable edge handles", () => {
    const flow = automationFlowSchema.parse({
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_first_message",
          position: { x: 0, y: 0 },
          data: { title: "Primeira mensagem", config: {} }
        },
        {
          id: "message-1",
          type: "send_message",
          position: { x: 260, y: 0 },
          data: { title: "Enviar mensagem", config: { text: "Olá!" } }
        }
      ],
      edges: [
        {
          id: "edge-1",
          source: "trigger-1",
          target: "message-1",
          sourceHandle: null,
          targetHandle: null
        }
      ]
    });

    expect(flow.edges[0]?.sourceHandle).toBeNull();
    expect(flow.edges[0]?.targetHandle).toBeNull();
  });

  it("rejects enabled flows that contain coming soon blocks", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "ai-1",
            type: "ai_classify_message",
            position: { x: 260, y: 0 },
            data: { title: "Classificar", config: {} }
          }
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "ai-1" }]
      },
      "enabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("O bloco Classificar mensagem ainda não pode ser usado em fluxos ativos.");
  });

  it("requires at least one trigger node", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "message-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { text: "Olá!" } }
          }
        ],
        edges: []
      },
      "disabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("O fluxo precisa ter pelo menos um gatilho.");
  });

  it("allows only one trigger node per flow", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "trigger-2",
            type: "trigger_keyword",
            position: { x: 260, y: 0 },
            data: { title: "Palavra-chave", config: { keyword: "preço" } }
          }
        ],
        edges: []
      },
      "disabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("O fluxo permite apenas um gatilho.");
  });

  it("rejects connections pointing into the trigger", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "message-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { text: "Olá!" } }
          }
        ],
        edges: [{ id: "edge-1", source: "message-1", target: "trigger-1" }]
      },
      "disabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("O gatilho não pode receber conexões.");
  });

  it("rejects duplicate edge ids", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "message-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { text: "Olá!" } }
          }
        ],
        edges: [
          { id: "edge-1", source: "trigger-1", target: "message-1" },
          { id: "edge-1", source: "message-1", target: "trigger-1" }
        ]
      },
      "disabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("A conexao edge-1 esta duplicada.");
  });

  it("rejects edges connected to missing nodes", () => {
    const result = validateAutomationFlowForStatus(
      {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          }
        ],
        edges: [{ id: "edge-1", source: "missing-source", target: "missing-target" }]
      },
      "disabled"
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("A conexao edge-1 sai de um bloco inexistente.");
    expect(result.errors).toContain("A conexao edge-1 aponta para um bloco inexistente.");
  });

  it("keeps block ids unique in the catalog", () => {
    const ids = automationBlockCatalog.map((block) => block.type);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("supports the external webhook trigger and requires its channel when enabled", () => {
    expect(getAutomationBlock("trigger_webhook")?.support).toBe("supported");

    const flow = automationFlowSchema.parse({
      version: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger_webhook",
          position: { x: 0, y: 0 },
          data: { title: "Webhook externo", config: {} }
        }
      ],
      edges: []
    });

    expect(validateAutomationFlowForStatus(flow, "disabled").success).toBe(true);
    expect(validateAutomationFlowForStatus(flow, "enabled").errors).toContain(
      "Escolha o canal do WhatsApp no gatilho Webhook externo."
    );

    const configured = {
      ...flow,
      nodes: [{ ...flow.nodes[0]!, data: { title: "Webhook externo", config: { channelId: " channel-1 " } } }]
    };
    const trigger = findWebhookTriggerNode(configured);

    expect(trigger?.id).toBe("trigger-1");
    expect(trigger ? readWebhookTriggerChannelId(trigger) : null).toBe("channel-1");
    expect(validateAutomationFlowForStatus(configured, "enabled").success).toBe(true);
  });

  it("builds the public webhook path contract", () => {
    const path = automationWebhookPath("abc_DEF-123");

    expect(path).toBe("/webhooks/automations/abc_DEF-123");
    expect(
      automationWebhookSchema.parse({
        automationId: "rule-1",
        token: "abc_DEF-123",
        path,
        createdAt: "2026-10-11T12:00:00.000Z",
        updatedAt: "2026-10-11T12:00:00.000Z"
      }).path
    ).toBe(path);
  });
});
