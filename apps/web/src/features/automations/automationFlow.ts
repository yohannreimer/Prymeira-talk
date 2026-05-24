import type { Edge, Node, XYPosition } from "@xyflow/react";
import {
  automationBlockCatalog,
  automationFlowSchema,
  getAutomationBlock,
  type AutomationBlockCategory,
  type AutomationBlockDefinition,
  type AutomationBlockSupport,
  type AutomationBlockType,
  type AutomationEdgeDefinition,
  type AutomationFlowDefinition
} from "@prymeira-talk/shared";

export interface AutomationCanvasNodeData extends Record<string, unknown> {
  blockType: AutomationBlockType;
  title: string;
  description: string;
  category: AutomationBlockCategory;
  support: AutomationBlockSupport;
  config: Record<string, unknown>;
}

export type AutomationCanvasNode = Node<AutomationCanvasNodeData, AutomationBlockType>;
export type AutomationCanvasEdge = Edge;

let nextNodeId = 0;

export function supportedBlockTypes(): AutomationBlockDefinition[] {
  return automationBlockCatalog;
}

export function createAutomationNode(
  type: AutomationBlockType,
  position: XYPosition
): AutomationCanvasNode {
  const block = getAutomationBlock(type);

  if (!block) {
    throw new Error(`Unknown automation block: ${type}`);
  }

  nextNodeId += 1;

  return {
    id: `${type}-${nextNodeId}`,
    type: block.type,
    position,
    data: {
      blockType: block.type,
      title: block.label,
      description: block.description,
      category: block.category,
      support: block.support,
      config: {}
    }
  };
}

export function createDefaultAutomationFlow(): AutomationFlowDefinition {
  return flowToAutomationPayload(
    [createAutomationNode("trigger_first_message", { x: 80, y: 180 })],
    []
  );
}

export function flowToAutomationPayload(
  nodes: AutomationCanvasNode[],
  edges: AutomationCanvasEdge[]
): AutomationFlowDefinition {
  const payload = {
    version: 1 as const,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.blockType,
      position: node.position,
      data: {
        title: node.data.title,
        config: node.data.config ?? {}
      }
    })),
    edges: edges.map((edge) => {
      const payloadEdge: AutomationEdgeDefinition = {
        id: edge.id,
        source: edge.source,
        target: edge.target
      };

      if (edge.sourceHandle != null) {
        payloadEdge.sourceHandle = edge.sourceHandle;
      }

      if (edge.targetHandle != null) {
        payloadEdge.targetHandle = edge.targetHandle;
      }

      return payloadEdge;
    })
  };

  return automationFlowSchema.parse(payload);
}
