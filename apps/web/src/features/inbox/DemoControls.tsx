import { FlaskConical, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { DemoLeadResultDto, DemoResetResultDto } from "../../app/api";

type DemoActionKind = "simulate" | "reset";

type RunDemoControlActionInput = {
  kind: DemoActionKind;
  onSimulateLead: () => Promise<DemoLeadResultDto>;
  onReset: () => Promise<DemoResetResultDto>;
  confirmReset: () => boolean;
};

export async function runDemoControlAction(input: RunDemoControlActionInput) {
  if (input.kind === "reset") {
    if (!input.confirmReset()) return null;

    const result = await input.onReset();
    return {
      conversationId: null,
      notice: `Demonstração restaurada: ${result.users} vendedores e ${result.conversations} conversas.`
    };
  }

  const result = await input.onSimulateLead();
  return {
    conversationId: result.conversationId,
    notice: "Lead qualificado pela IA e pronto para atendimento."
  };
}

type DemoControlsProps = {
  enabled: boolean;
  onSimulateLead: () => Promise<DemoLeadResultDto>;
  onReset: () => Promise<DemoResetResultDto>;
  onScenarioChanged: (conversationId: string | null) => void;
};

export function DemoControls(props: DemoControlsProps) {
  const [busyAction, setBusyAction] = useState<DemoActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!props.enabled) return null;

  async function handleAction(kind: DemoActionKind) {
    setBusyAction(kind);
    setError(null);
    setNotice(null);

    try {
      const result = await runDemoControlAction({
        kind,
        onSimulateLead: props.onSimulateLead,
        onReset: props.onReset,
        confirmReset: () => window.confirm("Restaurar todos os dados da demonstração?")
      });

      if (!result) return;
      setNotice(result.notice);
      props.onScenarioChanged(result.conversationId);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Não foi possível executar a demonstração.");
    } finally {
      setBusyAction(null);
    }
  }

  const isBusy = busyAction !== null;

  return (
    <div className="demo-control-shell" aria-label="Controles da demonstração">
      <div className="demo-control-heading">
        <span className="demo-control-badge">
          <FlaskConical size={12} aria-hidden="true" />
          Demo local
        </span>
        <span>Cenário B2B controlado</span>
      </div>
      <div className="demo-control-actions">
        <button disabled={isBusy} onClick={() => void handleAction("simulate")} type="button">
          {busyAction === "simulate" ? (
            <LoaderCircle className="demo-control-spinner" size={14} aria-hidden="true" />
          ) : (
            <Sparkles size={14} aria-hidden="true" />
          )}
          Simular novo lead
        </button>
        <button
          className="demo-control-reset"
          disabled={isBusy}
          onClick={() => void handleAction("reset")}
          type="button"
        >
          {busyAction === "reset" ? (
            <LoaderCircle className="demo-control-spinner" size={14} aria-hidden="true" />
          ) : (
            <RotateCcw size={14} aria-hidden="true" />
          )}
          Restaurar
        </button>
      </div>
      {notice ? <p className="demo-control-notice">{notice}</p> : null}
      {error ? <p className="demo-control-error">{error}</p> : null}
    </div>
  );
}
