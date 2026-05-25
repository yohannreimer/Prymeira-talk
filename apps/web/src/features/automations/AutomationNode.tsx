import { Handle, Position, type NodeProps } from "@xyflow/react";
import { MessageSquare, Tag, Timer, Workflow, Zap } from "lucide-react";
import type { AutomationCanvasNode } from "./automationFlow";

const categoryIcons = {
  trigger: Zap,
  communication: MessageSquare,
  decision: Workflow,
  time: Timer,
  crm: Tag,
  integration: Workflow,
  control: Workflow
};

export function AutomationNode({ data, selected }: NodeProps<AutomationCanvasNode>) {
  const Icon = categoryIcons[data.category] ?? Workflow;
  const isTrigger = data.category === "trigger";

  return (
    <article className={`automation-canvas-node ${isTrigger ? "automation-canvas-node--trigger" : ""} ${selected ? "is-selected" : ""}`}>
      {isTrigger ? null : (
        <Handle className="automation-node-handle" id="input" type="target" position={Position.Left} />
      )}
      <div className="automation-node-title-row">
        <span className="automation-node-icon" aria-hidden="true">
          <Icon size={14} />
        </span>
        <strong>{data.title}</strong>
        {isTrigger ? (
          <span className="automation-node-badge automation-node-badge--trigger">Gatilho</span>
        ) : data.support !== "supported" ? (
          <span className={`automation-node-badge automation-node-badge--${data.support}`}>
            {data.support === "coming_soon" ? "Em breve" : "Visual"}
          </span>
        ) : null}
      </div>
      <p>{data.description}</p>
      <Handle
        className={`automation-node-handle ${isTrigger ? "automation-node-handle--trigger-output" : ""}`}
        id="success"
        type="source"
        position={Position.Right}
      />
    </article>
  );
}
