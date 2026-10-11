import { meetingRemindersConfigSchema, type MeetingRemindersConfig, type MeetingReminderStep } from "@prymeira-talk/shared";

const UNITS = [
  { value: "minutes", label: "minutos", factor: 1 },
  { value: "hours", label: "horas", factor: 60 },
  { value: "days", label: "dias", factor: 1440 }
] as const;

type Unit = (typeof UNITS)[number]["value"];

export function splitMinutesBefore(minutes: number): { amount: number; unit: Unit } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

function factorOf(unit: Unit) {
  return UNITS.find((item) => item.value === unit)!.factor;
}

export function validateMeetingReminders(config: MeetingRemindersConfig): string | null {
  const parsed = meetingRemindersConfigSchema.safeParse(config);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue?.path.includes("minutesBefore")) return "Cada lembrete precisa sair entre 5 minutos e 7 dias antes da call.";
  if (issue?.path.includes("mediaUrl")) return "O link do arquivo do lembrete precisa começar com https://.";
  return issue?.message && !issue.message.startsWith("Invalid") && !issue.message.startsWith("Too")
    ? issue.message
    : "Revise as mensagens antes da call: cada uma precisa de texto ou de um arquivo.";
}

export function MeetingRemindersEditor({ value, onChange }: {
  value: MeetingRemindersConfig;
  onChange: (value: MeetingRemindersConfig) => void;
}) {
  const updateStep = (index: number, step: MeetingReminderStep) =>
    onChange({ ...value, steps: value.steps.map((item, position) => (position === index ? step : item)) });

  return (
    <section className="agents-card" aria-label="Mensagens antes da call">
      <header className="agents-card__header agents-card__header--split">
        <div>
          <h3>Mensagens antes da call</h3>
          <p>Saem sozinhas no WhatsApp antes de cada call que este agente marcar. Se a call for remarcada, elas acompanham o novo horário.</p>
        </div>
        <span>{value.steps.length} de 5</span>
      </header>
      <label className="agents-switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        <span className="agents-switch-row__body">
          <strong>Enviar mensagens antes da call</strong>
          <span>No texto, use {"{{primeiro_nome}}"}, {"{{dia}}"}, {"{{hora}}"} e {"{{link}}"} (o link do Meet).</span>
        </span>
      </label>

      {value.enabled ? (
        <>
          {value.steps.map((step, index) => {
            const { amount, unit } = splitMinutesBefore(step.minutesBefore);
            return (
              <div className="module-form" key={index} aria-label={`Lembrete ${index + 1}`}>
                <div className="knowledge-form-grid">
                  <label className="form-field">
                    Lembrete {index + 1}: quanto tempo antes
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={amount}
                      onChange={(event) => updateStep(index, { ...step, minutesBefore: Math.round(Number(event.target.value) * factorOf(unit)) })}
                    />
                  </label>
                  <label className="form-field">
                    Unidade
                    <select
                      aria-label={`Unidade do lembrete ${index + 1}`}
                      value={unit}
                      onChange={(event) => updateStep(index, { ...step, minutesBefore: amount * factorOf(event.target.value as Unit) })}
                    >
                      {UNITS.map((item) => <option key={item.value} value={item.value}>{item.label} antes</option>)}
                    </select>
                  </label>
                </div>
                {step.messages.map((message, messageIndex) => (
                  <div key={messageIndex}>
                    <label className="form-field">
                      Mensagem {messageIndex + 1}
                      <textarea
                        rows={3}
                        maxLength={1000}
                        value={message.text}
                        placeholder="Oi, {{primeiro_nome}}! Passando pra lembrar da nossa call hoje às {{hora}}."
                        onChange={(event) => updateStep(index, {
                          ...step,
                          messages: step.messages.map((item, position) => (position === messageIndex ? { ...item, text: event.target.value } : item))
                        })}
                      />
                    </label>
                    <label className="form-field">
                      Arquivo da mensagem {messageIndex + 1} (opcional)
                      <input
                        type="url"
                        value={message.mediaUrl ?? ""}
                        placeholder="https://... (imagem, vídeo ou PDF; o texto vira a legenda)"
                        onChange={(event) => updateStep(index, {
                          ...step,
                          messages: step.messages.map((item, position) => (position === messageIndex ? { ...item, mediaUrl: event.target.value.trim() || null } : item))
                        })}
                      />
                    </label>
                    {step.messages.length > 1 ? (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => updateStep(index, { ...step, messages: step.messages.filter((_, position) => position !== messageIndex) })}
                      >
                        Remover mensagem {messageIndex + 1}
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={step.messages.length >= 3}
                  onClick={() => updateStep(index, { ...step, messages: [...step.messages, { text: "", mediaUrl: null }] })}
                >
                  Adicionar mensagem
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onChange({ ...value, steps: value.steps.filter((_, position) => position !== index) })}
                >
                  Remover lembrete {index + 1}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="secondary-button"
            disabled={value.steps.length >= 5}
            onClick={() => onChange({
              ...value,
              steps: [...value.steps, { minutesBefore: nextMinutesBefore(value.steps), messages: [{ text: "", mediaUrl: null }] }]
            })}
          >
            Adicionar lembrete
          </button>
        </>
      ) : null}
    </section>
  );
}

function nextMinutesBefore(steps: MeetingReminderStep[]) {
  const used = new Set(steps.map((step) => step.minutesBefore));
  return [60, 180, 1440, 30, 15].find((minutes) => !used.has(minutes)) ?? 120;
}
