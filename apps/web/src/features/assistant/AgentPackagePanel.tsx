import {
  apiExportAgentPackage,
  apiImportAgentPackage,
  apiValidateAgentPackage,
  type AgentPackage,
  type AiAgentDto
} from "../../app/api";
import { CheckCircle2, Download, FileJson, PackageOpen } from "lucide-react";
import { useState, type ChangeEvent } from "react";

type AgentPackagePanelProps = {
  getToken: () => Promise<string | null>;
  selectedAgent: Pick<AiAgentDto, "id" | "name"> | null;
  onImported: (agent: AiAgentDto) => void;
};

export function packageDownloadFileName(agentName: string) {
  const slug = agentName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${slug || "agente"}.agent-package.json`;
}

export function AgentPackagePanel({
  getToken,
  selectedAgent,
  onImported
}: AgentPackagePanelProps) {
  const [agentPackage, setAgentPackage] = useState<AgentPackage | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function readPackageFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setFileName(file?.name ?? null);
    setAgentPackage(null);
    setVariableValues({});
    setError(null);
    setNotice(null);

    if (!file) {
      return;
    }

    setIsReading(true);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const validated = await apiValidateAgentPackage(getToken, parsed);
      setAgentPackage(validated.package);
      setVariableValues(
        Object.fromEntries(
          validated.package.variables.map((variable) => [
            variable.key,
            variable.defaultValue ?? ""
          ])
        )
      );
      setNotice("Modelo verificado. Preencha os dados desta empresa.");
    } catch (readError) {
      setError(
        readError instanceof SyntaxError
          ? "O arquivo não contém um JSON válido."
          : readError instanceof Error
            ? readError.message
            : "Não foi possível verificar o modelo."
      );
    } finally {
      setIsReading(false);
      event.target.value = "";
    }
  }

  async function importPackage() {
    if (!agentPackage) {
      return;
    }

    setIsImporting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiImportAgentPackage(getToken, {
        package: agentPackage,
        variableValues
      });
      onImported(result.agent);
      setNotice(
        `Agente criado como inativo, com ${result.knowledgeCount} fontes de conhecimento.`
      );
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "Não foi possível importar o modelo."
      );
    } finally {
      setIsImporting(false);
    }
  }

  async function exportPackage() {
    if (!selectedAgent) {
      return;
    }

    setIsExporting(true);
    setError(null);
    setNotice(null);
    try {
      const exported = await apiExportAgentPackage(getToken, selectedAgent.id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" })
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = packageDownloadFileName(selectedAgent.name);
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("Modelo exportado sem os valores privados desta implantação.");
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : "Não foi possível exportar o agente."
      );
    } finally {
      setIsExporting(false);
    }
  }

  const hasMissingRequiredVariables =
    agentPackage?.variables.some(
      (variable) => variable.required && !variableValues[variable.key]?.trim()
    ) ?? false;

  return (
    <section className="module-panel agent-package-panel" aria-label="Modelo reutilizável">
      <div className="agent-package-intro">
        <span className="agent-package-mark" aria-hidden="true">
          <PackageOpen size={19} />
        </span>
        <div>
          <p className="eyebrow">Configuração portátil</p>
          <h2>Modelo reutilizável</h2>
          <p>
            Importe a estrutura de atendimento de uma empresa ou transforme o agente
            selecionado em um arquivo reutilizável.
          </p>
        </div>
      </div>

      <div className="agent-package-actions">
        <div className="agent-package-lane">
          <div className="agent-package-lane__heading">
            <FileJson size={16} />
            <div>
              <strong>Importar modelo</strong>
              <span>Cria um novo agente inativo para você revisar.</span>
            </div>
          </div>
          <label className="form-field agent-package-file">
            Arquivo do modelo (.json)
            <input
              accept="application/json,.json"
              disabled={isReading || isImporting}
              onChange={(event) => void readPackageFile(event)}
              type="file"
            />
          </label>
          {fileName ? (
            <span className="agent-package-file-name">
              {isReading ? "Verificando" : "Arquivo"}: {fileName}
            </span>
          ) : null}

          {agentPackage ? (
            <div className="agent-package-summary">
              <div>
                <CheckCircle2 size={15} />
                <strong>{agentPackage.metadata.name}</strong>
              </div>
              <span>
                {agentPackage.agent.qualification.fields.length} campos de qualificação ·{" "}
                {agentPackage.knowledge.length} fontes
              </span>
            </div>
          ) : null}

          {agentPackage?.variables.map((variable) => (
            <label className="form-field" key={variable.key}>
              {variable.label}{variable.required ? " *" : ""}
              <input
                value={variableValues[variable.key] ?? ""}
                onChange={(event) =>
                  setVariableValues((current) => ({
                    ...current,
                    [variable.key]: event.target.value
                  }))
                }
                placeholder={variable.defaultValue ?? variable.label}
                required={variable.required}
              />
            </label>
          ))}

          <button
            className="primary-button"
            type="button"
            disabled={!agentPackage || hasMissingRequiredVariables || isImporting}
            onClick={() => void importPackage()}
          >
            <PackageOpen size={15} />
            {isImporting ? "Criando agente" : "Importar modelo"}
          </button>
        </div>

        <div className="agent-package-lane agent-package-lane--export">
          <div className="agent-package-lane__heading">
            <Download size={16} />
            <div>
              <strong>Exportar agente</strong>
              <span>Gera um .json sem os valores específicos da empresa.</span>
            </div>
          </div>
          <div className="agent-package-selection">
            <span>Agente selecionado</span>
            <strong>{selectedAgent?.name ?? "Selecione um agente para exportar"}</strong>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={!selectedAgent || isExporting}
            onClick={() => void exportPackage()}
          >
            <Download size={15} />
            {isExporting ? "Preparando arquivo" : "Exportar agente"}
          </button>
        </div>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}
    </section>
  );
}
