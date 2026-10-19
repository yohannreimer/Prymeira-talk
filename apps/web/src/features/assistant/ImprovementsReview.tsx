import type { AiAgentImprovementDto } from "../../app/api";
import { Check, HelpCircle, Lightbulb, Pencil, Save, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

type ImprovementFilter = AiAgentImprovementDto["status"] | "all";
type ImprovementFormState = { title: string; content: string };

/** How the list reaches the server: the agents page (one agent) or the owner's page (a customer's agents). */
export type ImprovementsApi = {
  update(improvement: AiAgentImprovementDto, body: Partial<{ title: string; content: string; reject: true; clarificationAnswers: Record<string, string> }>): Promise<AiAgentImprovementDto>;
  normalize(improvement: AiAgentImprovementDto): Promise<AiAgentImprovementDto>;
  approve(improvement: AiAgentImprovementDto, body: Partial<ImprovementFormState>): Promise<AiAgentImprovementDto>;
};

function emptyImprovementForm(): ImprovementFormState {
  return { title: "", content: "" };
}

function improvementKindLabel(kind: AiAgentImprovementDto["kind"]) {
  if (kind === "not_sold") return "Produto não comercializado";
  if (kind === "made_to_order") return "Sob encomenda";
  if (kind === "policy") return "Política";
  return "FAQ";
}

function improvementStatusLabel(status: AiAgentImprovementDto["status"]) {
  if (status === "accepted") return "Incluída na base";
  if (status === "rejected") return "Recusada";
  return "Pendente de revisão";
}

function improvementScopeLabel(scope: NonNullable<AiAgentImprovementDto["clarification"]["normalization"]>["scope"]) {
  if (scope === "requested_item_only") return "Apenas o item exatamente solicitado.";
  if (scope === "requested_item_variations") return "As variações confirmadas do item solicitado.";
  if (scope === "material_or_finish_family") return "A família de material ou acabamento confirmada.";
  return "O escopo amplo de catálogo confirmado pelo time.";
}

/**
 * The suggestions JEV learns when a person resolves a hand-over: complete the scope, let the AI prepare
 * the rule, then approve it into the knowledge base or refuse it.
 */
export function ImprovementsReview(props: {
  improvements: AiAgentImprovementDto[];
  loading: boolean;
  /** False before an agent or customer is chosen. */
  ready: boolean;
  api: ImprovementsApi;
  onUpdated: (improvement: AiAgentImprovementDto) => void;
  onApproved?: (improvement: AiAgentImprovementDto) => Promise<void> | void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  intro: ReactNode;
  approveConfirm: string;
  approvedNotice: string;
  /** Where a suggestion came from, when one list covers several workspaces. */
  origin?: (improvement: AiAgentImprovementDto) => string | null;
}) {
  const { improvements, api, onUpdated, onError, onNotice } = props;
  const [improvementFilter, setImprovementFilter] = useState<ImprovementFilter>("pending");
  const [editingImprovementId, setEditingImprovementId] = useState<string | null>(null);
  const [improvementForm, setImprovementForm] = useState<ImprovementFormState>(emptyImprovementForm);
  const [clarificationDrafts, setClarificationDrafts] = useState<Record<string, Record<string, string>>>({});
  const [improvementActionId, setImprovementActionId] = useState<string | null>(null);

  const pendingImprovementCount = improvements.filter((improvement) => improvement.status === "pending").length;
  const visibleImprovements = useMemo(
    () => improvementFilter === "all" ? improvements : improvements.filter((improvement) => improvement.status === improvementFilter),
    [improvementFilter, improvements]
  );

  function startEditingImprovement(improvement: AiAgentImprovementDto) {
    setEditingImprovementId(improvement.id);
    setImprovementForm({ title: improvement.title, content: improvement.content });
    onError(null);
    onNotice(null);
  }

  function cancelImprovementEditing() {
    setEditingImprovementId(null);
    setImprovementForm(emptyImprovementForm());
  }

  function clarificationAnswersFor(improvement: AiAgentImprovementDto) {
    return clarificationDrafts[improvement.id] ?? improvement.clarification.answers;
  }

  function clarificationIsComplete(improvement: AiAgentImprovementDto) {
    const answers = clarificationAnswersFor(improvement);
    return improvement.clarification.questions.every((question) => Boolean(answers[question.id]?.trim()));
  }

  function clarificationIsSaved(improvement: AiAgentImprovementDto) {
    const answers = clarificationAnswersFor(improvement);
    return improvement.clarification.questions.every(
      (question) => answers[question.id]?.trim() === improvement.clarification.answers[question.id]?.trim()
    );
  }

  function setClarificationAnswer(improvement: AiAgentImprovementDto, questionId: string, answer: string) {
    setClarificationDrafts((current) => ({
      ...current,
      [improvement.id]: { ...(current[improvement.id] ?? improvement.clarification.answers), [questionId]: answer }
    }));
  }

  /** Runs one action on a suggestion, one at a time, with the page's message for success or failure. */
  async function act(improvement: AiAgentImprovementDto, action: () => Promise<string | null>, failure: string) {
    if (improvementActionId) return;
    setImprovementActionId(improvement.id);
    onError(null);
    onNotice(null);
    try {
      const notice = await action();
      if (notice) onNotice(notice);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : failure);
    } finally {
      setImprovementActionId(null);
    }
  }

  function keepDrafts(updated: AiAgentImprovementDto) {
    setClarificationDrafts((current) => ({ ...current, [updated.id]: updated.clarification.answers }));
  }

  async function saveClarification(improvement: AiAgentImprovementDto) {
    if (!clarificationIsComplete(improvement)) {
      onError("Responda todas as perguntas de escopo. Quando não houver exceção, escreva “Nenhuma”.");
      return;
    }
    await act(improvement, async () => {
      const updated = await api.update(improvement, { clarificationAnswers: clarificationAnswersFor(improvement) });
      onUpdated(updated);
      keepDrafts(updated);
      return "Escopo salvo e incorporado ao conhecimento proposto.";
    }, "Não foi possível salvar as respostas de escopo.");
  }

  async function normalizeImprovement(improvement: AiAgentImprovementDto) {
    if (!clarificationIsComplete(improvement) || !clarificationIsSaved(improvement)) {
      onError("Complete e salve as respostas de escopo antes de pedir a interpretação do JEV.");
      return;
    }
    await act(improvement, async () => {
      const updated = await api.normalize(improvement);
      onUpdated(updated);
      keepDrafts(updated);
      return "A regra foi preparada e teve o escopo validado pelo JEV. Revise o texto antes de aprovar.";
    }, "Não foi possível preparar a regra para revisão.");
  }

  async function saveImprovement(improvement: AiAgentImprovementDto) {
    await act(improvement, async () => {
      onUpdated(await api.update(improvement, improvementForm));
      cancelImprovementEditing();
      return "Sugestão de aprimoramento atualizada.";
    }, "Não foi possível atualizar a sugestão de aprimoramento.");
  }

  async function approveImprovement(improvement: AiAgentImprovementDto) {
    if (improvementActionId) return;
    const isEditing = editingImprovementId === improvement.id;
    if (!clarificationIsComplete(improvement)) {
      onError("Complete e salve as perguntas de escopo antes de incluir este aprimoramento na base.");
      return;
    }
    if (!clarificationIsSaved(improvement)) {
      onError("Salve as respostas de escopo antes de incluir este aprimoramento na base.");
      return;
    }
    if (!improvement.clarification.normalization) {
      onError("Peça para o JEV interpretar o escopo antes de incluir este aprimoramento na base.");
      return;
    }
    if (!window.confirm(props.approveConfirm)) return;
    await act(improvement, async () => {
      const updated = await api.approve(improvement, isEditing ? improvementForm : {});
      onUpdated(updated);
      cancelImprovementEditing();
      await props.onApproved?.(updated);
      return props.approvedNotice;
    }, "Não foi possível aprovar a sugestão de aprimoramento.");
  }

  async function rejectImprovement(improvement: AiAgentImprovementDto) {
    if (improvementActionId) return;
    if (!window.confirm(`Recusar a sugestão “${improvement.title}”? Ela não será adicionada à base de conhecimento.`)) return;
    await act(improvement, async () => {
      onUpdated(await api.update(improvement, { reject: true }));
      if (editingImprovementId === improvement.id) cancelImprovementEditing();
      return "Sugestão de aprimoramento recusada.";
    }, "Não foi possível recusar a sugestão de aprimoramento.");
  }

  return (
    <section className="agents-card agent-improvements-panel" aria-label="Aprimoramentos do agente">
      <div className="panel-title-row">
        <div>
          <h2>Aprimoramentos</h2>
          <p className="agent-improvements-panel__intro">{props.intro}</p>
        </div>
        <span className={`status-badge status-badge--${pendingImprovementCount > 0 ? "waiting" : "open"}`}>
          {pendingImprovementCount} pendentes
        </span>
      </div>

      <div className="segmented-control" role="tablist" aria-label="Filtro de aprimoramentos">
        {([
          ["pending", "Pendentes"],
          ["accepted", "Incluídas"],
          ["rejected", "Recusadas"],
          ["all", "Todas"]
        ] as Array<[ImprovementFilter, string]>).map(([filter, label]) => (
          <button
            className={improvementFilter === filter ? "is-active" : ""}
            key={filter}
            onClick={() => setImprovementFilter(filter)}
            role="tab"
            aria-selected={improvementFilter === filter}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="agent-improvement-list" aria-label="Sugestões de aprimoramento">
        {props.loading ? <p className="list-note">Carregando aprimoramentos...</p> : null}
        {!props.loading && !props.ready ? (
          <p className="list-note">Selecione um agente para revisar seus aprimoramentos.</p>
        ) : null}
        {!props.loading && props.ready && visibleImprovements.length === 0 ? (
          <div className="agent-improvements-empty">
            <Lightbulb size={20} aria-hidden="true" />
            <div>
              <strong>Nenhuma sugestão nesta lista</strong>
              <p>
                Novas sugestões aparecem quando o humano resolve um repasse com uma orientação
                comercial clara e reutilizável.
              </p>
            </div>
          </div>
        ) : null}
        {visibleImprovements.map((improvement) => {
          const isEditing = editingImprovementId === improvement.id;
          const isWorking = improvementActionId === improvement.id;
          const clarificationComplete = clarificationIsComplete(improvement);
          const clarificationSaved = clarificationIsSaved(improvement);
          const clarificationAnswers = clarificationAnswersFor(improvement);
          const normalization = improvement.clarification.normalization;
          const origin = props.origin?.(improvement);

          return (
            <article className="agent-improvement-card" key={improvement.id}>
              <div className="agent-improvement-card__header">
                <div className="assistant-log-header">
                  <span className="status-badge status-badge--bot">
                    <Lightbulb size={12} />
                    {improvementKindLabel(improvement.kind)}
                  </span>
                  <span className={`status-badge status-badge--${
                    improvement.status === "pending"
                      ? "waiting"
                      : improvement.status === "accepted" ? "open" : "closed"
                  }`}>
                    {improvementStatusLabel(improvement.status)}
                  </span>
                  {origin ? <span className="status-badge status-badge--closed">{origin}</span> : null}
                </div>
              </div>

              {isEditing ? (
                <form
                  className="module-form agent-improvement-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveImprovement(improvement);
                  }}
                >
                  <label className="form-field">
                    Título da regra
                    <input
                      value={improvementForm.title}
                      onChange={(event) =>
                        setImprovementForm((current) => ({ ...current, title: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <label className="form-field">
                    Conteúdo que será usado pelo agente
                    <textarea
                      value={improvementForm.content}
                      onChange={(event) =>
                        setImprovementForm((current) => ({ ...current, content: event.target.value }))
                      }
                      rows={7}
                      required
                    />
                  </label>
                  <div className="agent-improvement-card__actions">
                    <button className="secondary-button" type="button" onClick={cancelImprovementEditing}>
                      Cancelar
                    </button>
                    <button className="secondary-button" type="submit" disabled={isWorking}>
                      <Save size={15} />
                      {isWorking ? "Salvando" : "Salvar edição"}
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={isWorking || !clarificationComplete || !clarificationSaved || !normalization}
                      onClick={() => void approveImprovement(improvement)}
                    >
                      <Check size={15} />
                      Aprovar e incluir
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <h3>{improvement.title}</h3>
                  {improvement.rationale ? (
                    <p className="agent-improvement-card__rationale">{improvement.rationale}</p>
                  ) : null}
                  <div className="agent-improvement-evidence">
                    <div>
                      <span>Pedido que originou a sugestão</span>
                      <p>{improvement.sourceCustomerMessage}</p>
                    </div>
                    <div>
                      <span>Resposta confirmada pelo humano</span>
                      <p>{improvement.sourceHumanReply}</p>
                    </div>
                  </div>
                  <div className="agent-improvement-proposal">
                    <span>Conhecimento proposto</span>
                    <p>{improvement.content}</p>
                  </div>
                  {improvement.status === "pending" ? (
                    <>
                      <section className="agent-improvement-clarification" aria-label="Completar escopo">
                        <div className="agent-improvement-clarification__header">
                          <HelpCircle size={17} aria-hidden="true" />
                          <div>
                            <h4>Complete o escopo antes de incluir</h4>
                            <p>
                              Essas respostas tornam a regra específica. Se não houver exceção,
                              responda “Nenhuma”.
                            </p>
                          </div>
                        </div>
                        <div className="agent-improvement-clarification__questions">
                          {improvement.clarification.questions.map((question) => (
                            <label className="form-field" key={question.id}>
                              {question.question}
                              <textarea
                                rows={3}
                                value={clarificationAnswers[question.id] ?? ""}
                                onChange={(event) =>
                                  setClarificationAnswer(improvement, question.id, event.target.value)
                                }
                                disabled={isWorking}
                                required
                              />
                              <small>{question.help}</small>
                            </label>
                          ))}
                        </div>
                        <div className="agent-improvement-card__actions">
                          <p className="agent-improvement-clarification__status">
                            {clarificationComplete
                              ? clarificationSaved
                                ? normalization
                                  ? "Regra preparada e escopo validado. Revise o texto e inclua quando estiver correto."
                                  : "Escopo salvo. Prepare a proposta para revisão antes de incluir."
                                : "Respostas prontas. Salve o escopo para atualizar a regra proposta."
                              : "Responda as duas perguntas para liberar a aprovação."}
                          </p>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void saveClarification(improvement)}
                            disabled={isWorking || !clarificationComplete || clarificationSaved}
                          >
                            <Save size={15} />
                            {isWorking ? "Salvando" : "Salvar escopo"}
                          </button>
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void normalizeImprovement(improvement)}
                            disabled={isWorking || !clarificationComplete || !clarificationSaved}
                          >
                            <Sparkles size={15} />
                            {isWorking ? "Preparando" : "Preparar regra com IA"}
                          </button>
                        </div>
                      </section>
                      {normalization ? (
                        <div className="agent-improvement-normalization" aria-live="polite">
                          <ShieldCheck size={17} aria-hidden="true" />
                          <div>
                            <strong>Regra interpretada pelo JEV</strong>
                            <p>
                              {improvementScopeLabel(normalization.scope)} {normalization.requiresHandoffOutsideScope
                                ? "Qualquer caso fora desse escopo seguirá para o comercial."
                                : "O escopo amplo foi confirmado pelo time."}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      <div className="agent-improvement-card__actions">
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => startEditingImprovement(improvement)}
                          disabled={isWorking}
                        >
                          <Pencil size={15} />
                          Editar
                        </button>
                        <button
                          className="secondary-button danger-button"
                          type="button"
                          onClick={() => void rejectImprovement(improvement)}
                          disabled={isWorking}
                        >
                          <Trash2 size={15} />
                          {isWorking ? "Processando" : "Recusar"}
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => void approveImprovement(improvement)}
                          disabled={isWorking || !clarificationComplete || !clarificationSaved || !normalization}
                        >
                          <Check size={15} />
                          {isWorking ? "Processando" : "Aprovar e incluir"}
                        </button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
