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
import { Plus, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationActionDto } from "../../app/api";
import { AutomationBlockLibrary } from "./AutomationBlockLibrary";
import { AutomationNode } from "./AutomationNode";
import { AutomationNodeInspector } from "./AutomationNodeInspector";
import {
  createAutomationNode,
  createDefaultAutomationFlow,
  flowToAutomationPayload,
  isTriggerBlock,
  replaceAutomationNodeType,
  type AutomationCanvasEdge,
  type AutomationCanvasNode
} from "./automationFlow";

interface AutomationCanvasProps {
  value?: unknown;
  onChange: (payload: AutomationFlowDefinition) => void;
  variant?: "editor" | "focus";
}

interface AutomationCanvasState {
  nodes: AutomationCanvasNode[];
  edges: AutomationCanvasEdge[];
}

const nodeTypes = Object.fromEntries(
  automationBlockCatalog.map((block) => [block.type, AutomationNode])
) as NodeTypes;

const legacyActionAliases: Record<string, AutomationBlockType> = {
  assign_department: "assign_user",
  create_crm_note: "create_internal_note"
};

function existingNodeIds(nodes: AutomationCanvasNode[]) {
  return nodes.map((node) => node.id);
}

function legacyActionBlockType(action: AutomationActionDto): AutomationBlockType {
  if (getAutomationBlock(action.type)) {
    return action.type as AutomationBlockType;
  }

  return legacyActionAliases[action.type] ?? "log_event";
}

function legacyActionConfig(action: AutomationActionDto): Record<string, unknown> {
  const config = { ...(action.config ?? {}) };

  if (action.label) {
    config.legacyLabel = action.label;
  }

  if (!getAutomationBlock(action.type) || legacyActionAliases[action.type]) {
    config.legacyType = action.type;
  }

  return config;
}

function canvasNodeFromPayloadNode(node: AutomationFlowDefinition["nodes"][number]): AutomationCanvasNode {
  const block = getAutomationBlock(node.type);

  if (!block) {
    throw new Error(`Unknown automation block: ${node.type}`);
  }

  return {
    id: node.id,
    type: block.type,
    position: node.position,
    draggable: block.category !== "trigger",
    deletable: block.category !== "trigger",
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
  const triggerNode = createAutomationNode("trigger_first_message", { x: 72, y: 160 });
  const nodes = [triggerNode];
  const edges: AutomationCanvasEdge[] = [];
  let previousNode = triggerNode;

  actions.forEach((action, index) => {
    const blockType = legacyActionBlockType(action);
    const actionNode = createAutomationNode(
      blockType,
      { x: 360 + index * 280, y: 160 },
      existingNodeIds(nodes)
    );

    actionNode.data.config = legacyActionConfig(action);
    nodes.push(actionNode);
    edges.push({
      id: `${previousNode.id}-${actionNode.id}`,
      source: previousNode.id,
      target: actionNode.id,
      sourceHandle: "success",
      targetHandle: "input"
    });
    previousNode = actionNode;
  });

  if (nodes.length === 1) {
    return null;
  }

  return {
    nodes,
    edges
  };
}

export function automationCanvasStateFromValue(value: unknown): AutomationCanvasState {
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

export function AutomationCanvas({ value, onChange, variant = "editor" }: AutomationCanvasProps) {
  const initialState = useMemo(() => automationCanvasStateFromValue(value), [value]);
  const [nodes, setNodes] = useState<AutomationCanvasNode[]>(initialState.nodes);
  const [edges, setEdges] = useState<AutomationCanvasEdge[]>(initialState.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialState.nodes[0]?.id ?? null);
  const [isFocusPaletteOpen, setFocusPaletteOpen] = useState(false);
  const [isFocusInspectorOpen, setFocusInspectorOpen] = useState(false);
  const isFocusMode = variant === "focus";

  useEffect(() => {
    onChange(flowToAutomationPayload(nodes, edges));
  }, [edges, nodes, onChange]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const handleNodesChange = useCallback((changes: NodeChange<AutomationCanvasNode>[]) => {
    setNodes((currentNodes) => {
      const protectedChanges = changes.filter((change) => {
        const node = "id" in change ? currentNodes.find((item) => item.id === change.id) : null;

        if (node?.data.category !== "trigger") {
          return true;
        }

        return change.type !== "remove" && change.type !== "position";
      });

      return applyNodeChanges(protectedChanges, currentNodes) as AutomationCanvasNode[];
    });

    if (changes.some((change) => change.type === "remove" && change.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId]);

  const handleEdgesChange = useCallback((changes: EdgeChange<AutomationCanvasEdge>[]) => {
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }, []);

  const handleConnect = useCallback((connection: Connection) => {
    const targetNode = nodes.find((node) => node.id === connection.target);
    if (targetNode?.data.category === "trigger") {
      return;
    }

    setEdges((currentEdges) => addEdge(connection, currentEdges));
  }, [nodes]);

  const handleSelectionChange = useCallback((selection: OnSelectionChangeParams) => {
    const nextSelectedNodeId = selection.nodes[0]?.id ?? null;

    setSelectedNodeId(nextSelectedNodeId);
    if (nextSelectedNodeId && isFocusMode) {
      setFocusInspectorOpen(true);
    }
  }, [isFocusMode]);

  const addBlock = useCallback((type: AutomationBlockType) => {
    setNodes((currentNodes) => {
      if (isTriggerBlock(type) && currentNodes.some((node) => node.data.category === "trigger")) {
        const triggerNode = currentNodes.find((node) => node.data.category === "trigger");
        if (triggerNode) {
          setSelectedNodeId(triggerNode.id);
          return currentNodes.map((node) =>
            node.id === triggerNode.id ? replaceAutomationNodeType(node, type) : node
          );
        }
        return currentNodes;
      }

      const anchorNode = currentNodes.find((node) => node.id === selectedNodeId) ?? currentNodes.at(-1);
      const position = anchorNode
        ? { x: anchorNode.position.x + 280, y: anchorNode.position.y + 24 }
        : { x: 96, y: 160 };
      const node = createAutomationNode(type, position, existingNodeIds(currentNodes));

      setSelectedNodeId(node.id);
      return [...currentNodes, node];
    });
  }, [selectedNodeId]);

  const updateNodeType = useCallback((nodeId: string, type: AutomationBlockType) => {
    const block = getAutomationBlock(type);
    if (!block) {
      return;
    }

    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === nodeId
          ? replaceAutomationNodeType(node, block.type)
          : node
      )
    );
  }, []);

  const addFocusBlock = useCallback((type: AutomationBlockType) => {
    addBlock(type);
    setFocusPaletteOpen(false);
    setFocusInspectorOpen(true);
  }, [addBlock]);

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
    <div className={`automation-canvas-shell automation-canvas-shell--${variant}`}>
      {isFocusMode ? null : (
        <AutomationBlockLibrary
          onSelect={addBlock}
        />
      )}

      <div
        className={`automation-canvas-surface ${isFocusMode ? "is-focus-mode" : ""}`}
        aria-label="Canvas da automacao"
      >
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

        {isFocusMode ? (
          <>
            <div className="automation-focus-toolbar" aria-label="Ferramentas do modo foco">
              <button
                className="button-primary automation-focus-action"
                onClick={() => setFocusPaletteOpen((current) => !current)}
                type="button"
              >
                {isFocusPaletteOpen ? <X size={16} /> : <Plus size={16} />}
                <span>Bloco</span>
              </button>
              <button
                className="button-ghost automation-focus-action"
                disabled={!selectedNode}
                onClick={() => setFocusInspectorOpen((current) => !current)}
                type="button"
              >
                <SlidersHorizontal size={16} />
                <span>Configurar</span>
              </button>
            </div>

            {isFocusPaletteOpen ? (
              <div className="automation-focus-popover">
                <AutomationBlockLibrary
                  onSelect={addFocusBlock}
                />
              </div>
            ) : null}

            {isFocusInspectorOpen ? (
              <div className="automation-focus-inspector">
                <AutomationNodeInspector
                  node={selectedNode}
                  onConfigChange={updateConfig}
                  onTypeChange={updateNodeType}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {isFocusMode ? null : (
        <AutomationNodeInspector
          node={selectedNode}
          onConfigChange={updateConfig}
          onTypeChange={updateNodeType}
        />
      )}
    </div>
  );
}
