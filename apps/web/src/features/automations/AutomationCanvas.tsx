import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  automationBlockCatalog,
  automationFlowSchema,
  getAutomationBlock,
  type AutomationBlockType,
  type AutomationFlowDefinition
} from "@prymeira-talk/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationActionDto } from "../../app/api";
import { AutomationBlockLibrary } from "./AutomationBlockLibrary";
import { AutomationNode } from "./AutomationNode";
import { AutomationNodeInspector } from "./AutomationNodeInspector";
import {
  createAutomationNode,
  createDefaultAutomationFlow,
  flowToAutomationPayload,
  type AutomationCanvasEdge,
  type AutomationCanvasNode
} from "./automationFlow";

interface AutomationCanvasProps {
  value?: unknown;
  onChange: (payload: AutomationFlowDefinition) => void;
}

interface AutomationCanvasState {
  nodes: AutomationCanvasNode[];
  edges: AutomationCanvasEdge[];
}

const nodeTypes = Object.fromEntries(
  automationBlockCatalog.map((block) => [block.type, AutomationNode])
) as NodeTypes;

function canvasNodeFromPayloadNode(node: AutomationFlowDefinition["nodes"][number]): AutomationCanvasNode {
  const block = getAutomationBlock(node.type);

  if (!block) {
    throw new Error(`Unknown automation block: ${node.type}`);
  }

  return {
    id: node.id,
    type: block.type,
    position: node.position,
    data: {
      blockType: block.type,
      title: node.data.title || block.label,
      description: block.description,
      category: block.category,
      support: block.support,
      config: node.data.config ?? {}
    }
  };
}

function canvasStateFromFlow(flow: AutomationFlowDefinition): AutomationCanvasState {
  return {
    nodes: flow.nodes.map(canvasNodeFromPayloadNode),
    edges: flow.edges
  };
}

function legacyActionToFlow(actions: AutomationActionDto[]): AutomationCanvasState | null {
  const firstAction = actions.find((action) => getAutomationBlock(action.type));

  if (!firstAction) {
    return null;
  }

  const block = getAutomationBlock(firstAction.type);

  if (!block) {
    return null;
  }

  const triggerNode = createAutomationNode("trigger_first_message", { x: 72, y: 160 });
  const actionNode = createAutomationNode(block.type, { x: 360, y: 160 });
  actionNode.data.config = firstAction.config ?? (firstAction.label ? { legacyLabel: firstAction.label } : {});

  return {
    nodes: [triggerNode, actionNode],
    edges: [
      {
        id: `${triggerNode.id}-${actionNode.id}`,
        source: triggerNode.id,
        target: actionNode.id,
        sourceHandle: "success",
        targetHandle: "input"
      }
    ]
  };
}

function initialCanvasState(value: unknown): AutomationCanvasState {
  const parsedFlow = automationFlowSchema.safeParse(value);

  if (parsedFlow.success) {
    return canvasStateFromFlow(parsedFlow.data);
  }

  if (Array.isArray(value)) {
    const legacyFlow = legacyActionToFlow(value);

    if (legacyFlow) {
      return legacyFlow;
    }
  }

  return canvasStateFromFlow(createDefaultAutomationFlow());
}

export function AutomationCanvas({ value, onChange }: AutomationCanvasProps) {
  const initialState = useMemo(() => initialCanvasState(value), [value]);
  const [nodes, setNodes] = useState<AutomationCanvasNode[]>(initialState.nodes);
  const [edges, setEdges] = useState<AutomationCanvasEdge[]>(initialState.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialState.nodes[0]?.id ?? null);

  useEffect(() => {
    onChange(flowToAutomationPayload(nodes, edges));
  }, [edges, nodes, onChange]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const handleNodesChange = useCallback((changes: NodeChange<AutomationCanvasNode>[]) => {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes) as AutomationCanvasNode[]);

    if (changes.some((change) => change.type === "remove" && change.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId]);

  const handleEdgesChange = useCallback((changes: EdgeChange<AutomationCanvasEdge>[]) => {
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }, []);

  const handleConnect = useCallback((connection: Connection) => {
    setEdges((currentEdges) => addEdge(connection, currentEdges));
  }, []);

  const handleSelectionChange = useCallback((selection: OnSelectionChangeParams) => {
    setSelectedNodeId(selection.nodes[0]?.id ?? null);
  }, []);

  const addBlock = useCallback((type: AutomationBlockType) => {
    setNodes((currentNodes) => {
      const anchorNode = currentNodes.find((node) => node.id === selectedNodeId) ?? currentNodes.at(-1);
      const position = anchorNode
        ? { x: anchorNode.position.x + 280, y: anchorNode.position.y + 24 }
        : { x: 96, y: 160 };
      const node = createAutomationNode(type, position);

      setSelectedNodeId(node.id);
      return [...currentNodes, node];
    });
  }, [selectedNodeId]);

  const updateConfig = useCallback((nodeId: string, config: Record<string, unknown>) => {
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                config
              }
            }
          : node
      )
    );
  }, []);

  return (
    <div className="automation-canvas-shell">
      <AutomationBlockLibrary onSelect={addBlock} />

      <div className="automation-canvas-surface" aria-label="Canvas da automacao">
        <ReactFlow
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.24 }}
          nodes={nodes}
          nodeTypes={nodeTypes}
          onConnect={handleConnect}
          onEdgesChange={handleEdgesChange}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onNodesChange={handleNodesChange}
          onPaneClick={() => setSelectedNodeId(null)}
          onSelectionChange={handleSelectionChange}
        >
          <Background color="#cfd8d4" gap={18} size={1.4} />
          <Controls position="bottom-left" />
          <MiniMap
            maskColor="rgba(248, 250, 248, 0.74)"
            nodeColor="#24564a"
            pannable
            position="bottom-right"
            zoomable
          />
        </ReactFlow>
      </div>

      <AutomationNodeInspector node={selectedNode} onConfigChange={updateConfig} />
    </div>
  );
}
