import type { AgentFollowupConfig } from "@prymeira-talk/shared";

export function emptyAgentFollowupConfig(): AgentFollowupConfig {
  return { timeZone: "America/Sao_Paulo", businessDays: [1, 2, 3, 4, 5],
    businessHours: { start: "08:00", end: "18:00" }, steps: [], closeAfterBusinessMinutes: 0 };
}

export function validateAgentFollowupConfig(config: AgentFollowupConfig): string | null {
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: config.timeZone }).format(new Date()); }
  catch { return "Informe um fuso horário válido, como America/Sao_Paulo."; }
  if (!config.businessDays.length) return "Escolha pelo menos um dia útil para as retomadas.";
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!validTime.test(config.businessHours.start) || !validTime.test(config.businessHours.end) ||
    config.businessHours.start >= config.businessHours.end) return "O horário final das retomadas deve ser posterior ao inicial.";
  if (config.steps.length > 10) return "Configure no máximo 10 etapas de retomada.";
  let previous = 0;
  for (const step of config.steps) {
    if (!Number.isInteger(step.afterBusinessMinutes) || step.afterBusinessMinutes <= previous)
      return "Os minutos úteis das etapas devem ser positivos e crescentes.";
    if (!step.instruction.trim() || step.instruction.length > 1000)
      return "Preencha a instrução de cada retomada, com até 1000 caracteres.";
    previous = step.afterBusinessMinutes;
  }
  return null;
}

export function AgentFollowupConfigEditor({ value, onChange }: {
  value: AgentFollowupConfig; onChange: (value: AgentFollowupConfig) => void;
}) {
  return <section className="agent-tag-selector" aria-label="Retomadas do agente">
    <div className="panel-title-row"><h3>Retomadas do agente</h3><span>{value.steps.length}/10 etapas</span></div>
    <p className="list-note">Comece sem retomadas ou adicione até 10 etapas. Os minutos úteis são cumulativos desde a última resposta do agente, dentro dos dias, horários e fuso definidos abaixo.</p>
    <p className="list-note">Uma nova resposta do contato cancela as retomadas pendentes. O plano reinicia após a próxima resposta do agente. Recusa, transferência ou atendimento humano interrompem as retomadas. Ao terminar as etapas, o agente continua disponível para responder.</p>
    <label className="form-field">Fuso horário das retomadas<input value={value.timeZone} maxLength={80}
      onChange={(event) => onChange({ ...value, timeZone: event.target.value })} /></label>
    <div className="tag-option-grid" aria-label="Dias úteis das retomadas">
      {["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((day, index) =>
        <label className="form-field form-field--checkbox" key={day}><input type="checkbox"
          checked={value.businessDays.includes(index)} onChange={(event) => onChange({ ...value,
            businessDays: event.target.checked ? [...value.businessDays, index].sort() : value.businessDays.filter((day) => day !== index) })} />{day}</label>)}
    </div>
    <div className="knowledge-form-grid">
      <label className="form-field">Retomadas: início<input type="time" value={value.businessHours.start}
        onChange={(event) => onChange({ ...value, businessHours: { ...value.businessHours, start: event.target.value } })} /></label>
      <label className="form-field">Retomadas: fim<input type="time" value={value.businessHours.end}
        onChange={(event) => onChange({ ...value, businessHours: { ...value.businessHours, end: event.target.value } })} /></label>
    </div>
    {value.steps.map((step, index) => <div className="module-form" key={index}>
      <label className="form-field">Etapa {index + 1}: minutos úteis<input type="number" min={1} step={1}
        value={step.afterBusinessMinutes} onChange={(event) => onChange({ ...value,
          steps: value.steps.map((item, position) => position === index ? { ...item, afterBusinessMinutes: Number(event.target.value) } : item) })} /></label>
      <label className="form-field">Etapa {index + 1}: instrução<textarea rows={3} maxLength={1000} required value={step.instruction}
        onChange={(event) => onChange({ ...value, steps: value.steps.map((item, position) =>
          position === index ? { ...item, instruction: event.target.value } : item) })} /></label>
      <button type="button" className="secondary-button" onClick={() => onChange({ ...value,
        steps: value.steps.filter((_, position) => position !== index) })}>Remover etapa {index + 1}</button>
    </div>)}
    <button type="button" className="secondary-button" disabled={value.steps.length >= 10}
      onClick={() => onChange({ ...value, steps: [...value.steps, {
        afterBusinessMinutes: (value.steps.at(-1)?.afterBusinessMinutes ?? 0) + 60, instruction: "" }] })}>Adicionar retomada</button>
  </section>;
}
