import type { AutomationCanvasNode } from "./automationFlow";

interface AutomationNodeInspectorProps {
  node: AutomationCanvasNode | null;
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void;
}

function readConfigValue(config: Record<string, unknown>, key: string) {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function updateConfigValue(
  node: AutomationCanvasNode,
  key: string,
  value: string,
  onConfigChange: AutomationNodeInspectorProps["onConfigChange"]
) {
  onConfigChange(node.id, {
    ...node.data.config,
    [key]: value
  });
}

export function AutomationNodeInspector({ node, onConfigChange }: AutomationNodeInspectorProps) {
  if (!node) {
    return (
      <aside className="automation-node-inspector" aria-label="Configuracao do bloco">
        <div className="automation-panel-heading">
          <h3>Configuracao</h3>
        </div>
        <div className="automation-inspector-empty">
          <strong>Selecione um bloco</strong>
          <p>Ajuste mensagens, arquivos, tags e etapas sem sair do canvas.</p>
        </div>
      </aside>
    );
  }

  const type = node.data.blockType;
  const config = node.data.config ?? {};
  const showsMessage = type === "send_message" || type === "send_quick_reply" || type === "ask_open_reply";
  const showsFile = type === "send_file" || type === "send_image";
  const showsTag = type === "add_tag" || type === "remove_tag";
  const showsBoardStage = type === "move_board_stage";
  const hasSupportedInputs = showsMessage || showsFile || showsTag || showsBoardStage;

  return (
    <aside className="automation-node-inspector" aria-label="Configuracao do bloco">
      <div className="automation-panel-heading">
        <h3>Configurar</h3>
        {node.data.support !== "supported" ? (
          <span className={`automation-support-pill automation-support-pill--${node.data.support}`}>
            {node.data.support === "coming_soon" ? "Em breve" : "Visual"}
          </span>
        ) : null}
      </div>

      <div className="automation-inspector-summary">
        <strong>{node.data.title}</strong>
        <p>{node.data.description}</p>
      </div>

      {showsMessage ? (
        <label className="form-field">
          <span>{type === "send_quick_reply" ? "Mensagem padrao" : "Mensagem"}</span>
          <textarea
            onChange={(event) => updateConfigValue(node, "message", event.target.value, onConfigChange)}
            placeholder="Escreva o texto enviado ao contato"
            rows={5}
            value={readConfigValue(config, "message")}
          />
        </label>
      ) : null}

      {showsFile ? (
        <div className="automation-inspector-fields">
          <label className="form-field">
            <span>Nome do arquivo</span>
            <input
              onChange={(event) => updateConfigValue(node, "fileName", event.target.value, onConfigChange)}
              placeholder={type === "send_image" ? "produto.png" : "proposta.pdf"}
              value={readConfigValue(config, "fileName")}
            />
          </label>
          <label className="form-field">
            <span>URL ou caminho</span>
            <input
              onChange={(event) => updateConfigValue(node, "fileUrl", event.target.value, onConfigChange)}
              placeholder="https://..."
              value={readConfigValue(config, "fileUrl")}
            />
          </label>
        </div>
      ) : null}

      {showsTag ? (
        <label className="form-field">
          <span>Tag</span>
          <input
            onChange={(event) => updateConfigValue(node, "tagName", event.target.value, onConfigChange)}
            placeholder="Ex: lead quente"
            value={readConfigValue(config, "tagName")}
          />
        </label>
      ) : null}

      {showsBoardStage ? (
        <div className="automation-inspector-fields">
          <label className="form-field">
            <span>Board</span>
            <input
              onChange={(event) => updateConfigValue(node, "boardLabel", event.target.value, onConfigChange)}
              placeholder="Ex: Vendas"
              value={readConfigValue(config, "boardLabel")}
            />
          </label>
          <label className="form-field">
            <span>Etapa</span>
            <input
              onChange={(event) => updateConfigValue(node, "stageLabel", event.target.value, onConfigChange)}
              placeholder="Ex: Proposta enviada"
              value={readConfigValue(config, "stageLabel")}
            />
          </label>
        </div>
      ) : null}

      {!hasSupportedInputs ? (
        <p className="list-note">
          Este bloco ainda nao tem campos editaveis nesta primeira versao do canvas.
        </p>
      ) : null}
    </aside>
  );
}
