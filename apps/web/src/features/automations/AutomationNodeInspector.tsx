import { automationBlockCatalog, type AutomationBlockType } from "@prymeira-talk/shared";
import { Upload } from "lucide-react";
import { useState } from "react";
import { apiUploadAutomationAsset } from "../../app/api";
import { useTalkAuth } from "../../app/auth";
import type { AutomationCanvasNode } from "./automationFlow";

interface AutomationNodeInspectorProps {
  node: AutomationCanvasNode | null;
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void;
  onTypeChange?: (nodeId: string, type: AutomationBlockType) => void;
}

function readConfigValue(config: Record<string, unknown>, key: string) {
  const value = config[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" ? value : "";
}

export function keywordInputToConfig(value: string): { keywordInput?: string; keywords?: string[] } {
  const keywords = value
    .split(/[,\n]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  return value.length > 0 ? { keywordInput: value, ...(keywords.length > 0 ? { keywords } : {}) } : {};
}

export function keywordConfigToInputValue(config: Record<string, unknown>) {
  const keywordInput = config.keywordInput;
  if (typeof keywordInput === "string") {
    return keywordInput;
  }

  const keywords = config.keywords;

  if (Array.isArray(keywords)) {
    return keywords
      .filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0)
      .map((keyword) => keyword.trim())
      .join(", ");
  }

  return readConfigValue(config, "keyword") || readConfigValue(config, "text");
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

export function AutomationNodeInspector({ node, onConfigChange, onTypeChange }: AutomationNodeInspectorProps) {
  const { getToken } = useTalkAuth();
  const [uploadingNodeId, setUploadingNodeId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
  const isTrigger = node.data.category === "trigger";
  const showsMessage = type === "send_message" || type === "send_quick_reply" || type === "ask_open_reply";
  const showsFile = type === "send_file" || type === "send_image";
  const showsTag = type === "add_tag" || type === "remove_tag";
  const showsBoardStage = type === "move_board_stage";
  const showsKeywordTrigger = type === "trigger_keyword";
  const showsReengagementTrigger = type === "trigger_reengagement";
  const triggerBlocks = automationBlockCatalog.filter(
    (block) => block.category === "trigger" && block.support === "supported"
  );
  const hasSupportedInputs =
    isTrigger ||
    showsMessage ||
    showsFile ||
    showsTag ||
    showsBoardStage;

  async function uploadAutomationFile(file: File | null) {
    if (!file || !node) return;

    setUploadingNodeId(node.id);
    setUploadError(null);

    try {
      const result = await apiUploadAutomationAsset(getToken, file);
      onConfigChange(node.id, {
        ...node.data.config,
        fileName: result.fileName,
        fileUrl: result.url,
        mimetype: result.mimeType,
        mediaUrl: result.url
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Nao foi possivel enviar o arquivo.");
    } finally {
      setUploadingNodeId(null);
    }
  }

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

      {isTrigger ? (
        <div className="automation-inspector-fields">
          <label className="form-field">
            <span>Tipo de gatilho</span>
            <select
              onChange={(event) => onTypeChange?.(node.id, event.target.value as AutomationBlockType)}
              value={type}
            >
              {triggerBlocks.map((block) => (
                <option key={block.type} value={block.type}>
                  {block.label}
                </option>
              ))}
            </select>
          </label>

          {type === "trigger_first_message" ? (
            <p className="list-note">
              Executa somente quando essa conversa ainda nao tinha mensagens inbound anteriores.
            </p>
          ) : null}

          {showsReengagementTrigger ? (
            <label className="form-field">
              <span>Dias sem mensagem</span>
              <input
                min="1"
                onChange={(event) => updateConfigValue(node, "pauseDays", event.target.value, onConfigChange)}
                placeholder="Ex: 3"
                type="number"
                value={readConfigValue(config, "pauseDays")}
              />
            </label>
          ) : null}

          {showsKeywordTrigger ? (
            <label className="form-field">
              <span>Palavras ou frases</span>
              <textarea
                onChange={(event) => {
                  const {
                    keyword: _keyword,
                    keywordInput: _keywordInput,
                    keywords: _keywords,
                    text: _text,
                    ...restConfig
                  } = node.data.config;
                  onConfigChange(node.id, {
                    ...restConfig,
                    ...keywordInputToConfig(event.target.value)
                  });
                }}
                placeholder={"Ex: catalogo\npreco\nsuporte"}
                rows={4}
                value={keywordConfigToInputValue(config)}
              />
            </label>
          ) : null}
        </div>
      ) : null}

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
          <label className="automation-upload-control">
            <Upload size={16} aria-hidden="true" />
            <span>{uploadingNodeId === node.id ? "Enviando..." : "Enviar arquivo"}</span>
            <input
              accept={type === "send_image" ? "image/*" : undefined}
              className="visually-hidden"
              disabled={uploadingNodeId === node.id}
              onChange={(event) => {
                void uploadAutomationFile(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
              type="file"
            />
          </label>
          {readConfigValue(config, "fileUrl") ? (
            <div className="automation-upload-summary">
              <strong>{readConfigValue(config, "fileName") || "Arquivo enviado"}</strong>
              <span>{readConfigValue(config, "mimetype") || "Arquivo publico"}</span>
            </div>
          ) : (
            <p className="list-note">O arquivo sera salvo e usado por uma URL publica do Prymeira Talk.</p>
          )}
          {uploadError ? <p className="error-note">{uploadError}</p> : null}
          <label className="form-field">
            <span>Legenda opcional</span>
            <textarea
              onChange={(event) => updateConfigValue(node, "caption", event.target.value, onConfigChange)}
              placeholder={type === "send_image" ? "Texto que acompanha a imagem" : "Texto que acompanha o arquivo"}
              rows={3}
              value={readConfigValue(config, "caption")}
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
