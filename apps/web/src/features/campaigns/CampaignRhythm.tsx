import type { CampaignCadenceDto } from "../../app/api";
import { DAILY_PRESET, WEEKDAY_SHORT, estimateDays, isDaily, shortDay, weekdaysLabel, withDaily, withoutDaily } from "./campaign-rhythm";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * When the messages go out: all on the same day (the moderate pace) or spread over days (~40 a day, varying, only on
 * the chosen weekdays and hours). Variations, AI follow-up and number checks are the same in both.
 */
export function CampaignRhythm(props: {
  cadence: CampaignCadenceDto;
  onChange: (cadence: CampaignCadenceDto) => void;
  /** How many contacts, when known (for the calendar estimate). */
  audienceSize: number | null;
  start: Date;
  sameDay: React.ReactNode;
}) {
  const { cadence } = props;
  const daily = isDaily(cadence);
  const set = (patch: Partial<CampaignCadenceDto>) => props.onChange({ ...cadence, ...patch });
  const weekdays = cadence.weekdays?.length ? cadence.weekdays : DAILY_PRESET.weekdays!;
  const days = props.audienceSize ? estimateDays(props.audienceSize, cadence, props.start) : [];
  const toggleDay = (day: number) => {
    const next = weekdays.includes(day) ? weekdays.filter(item => item !== day) : [...weekdays, day].sort();
    if (next.length) set({ weekdays: next });
  };
  return <section className="campaign-rhythm" aria-label="Ritmo de envio">
    <div className="campaign-rhythm-head"><h3>Ritmo de envio</h3>
      <div className="campaign-segmented" role="radiogroup" aria-label="Como espalhar os envios">
        <button type="button" role="radio" aria-checked={!daily} className={!daily ? "is-on" : ""}
          onClick={() => props.onChange(withoutDaily(cadence))}>Tudo no mesmo dia</button>
        <button type="button" role="radio" aria-checked={daily} className={daily ? "is-on" : ""}
          onClick={() => props.onChange(withDaily(cadence))}>Espalhar em vários dias</button>
      </div></div>
    {!daily ? props.sameDay : <>
      <div className="campaign-rhythm-grid">
        <label><span>Mensagens por dia</span>
          <span className="campaign-rhythm-range">
            <input type="number" min={1} max={500} aria-label="Mínimo por dia" value={cadence.dailyMin ?? ""}
              onChange={event => set({ dailyMin: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} />
            <em>a</em>
            <input type="number" min={1} max={500} aria-label="Máximo por dia" value={cadence.dailyMax ?? ""}
              onChange={event => set({ dailyMax: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} />
          </span></label>
        <label><span>Horário</span>
          <span className="campaign-rhythm-range">
            <input type="time" aria-label="Início do horário" value={cadence.windowStart ?? "09:00"} onChange={event => set({ windowStart: event.target.value })} />
            <em>às</em>
            <input type="time" aria-label="Fim do horário" value={cadence.windowEnd ?? "18:00"} onChange={event => set({ windowEnd: event.target.value })} />
          </span></label>
        <div className="campaign-rhythm-days"><span>Dias</span>
          <div role="group" aria-label="Dias da semana">{WEEK_ORDER.map(day =>
            <button type="button" key={day} aria-pressed={weekdays.includes(day)} className={weekdays.includes(day) ? "is-on" : ""}
              onClick={() => toggleDay(day)}>{WEEKDAY_SHORT[day]}</button>)}</div></div>
      </div>
      {(cadence.dailyMin ?? 0) > (cadence.dailyMax ?? 0) ? <p className="campaign-rhythm-warning" role="alert">O mínimo por dia precisa ser menor ou igual ao máximo.</p> : null}
      <p className="campaign-rhythm-note">Cada dia sorteia quantas mensagens sair ({cadence.dailyMin} a {cadence.dailyMax}) e espalha os envios ao longo do horário, com intervalos diferentes entre eles. Se sobrar alguém num dia, passa para o próximo dia permitido.</p>
      {days.length ? <div className="campaign-rhythm-calendar">
        <p><b>{props.audienceSize} contatos</b> · cerca de <b>{days.length} {days.length === 1 ? "dia" : "dias"}</b> de envio ({weekdaysLabel(weekdays)}, {cadence.windowStart}–{cadence.windowEnd}) · termina por volta de <b>{shortDay(days.at(-1)!.date)}</b></p>
        <ol>{days.slice(0, 10).map(day => <li key={day.date.toISOString()}><span>{shortDay(day.date)}</span><b>~{day.count}</b></li>)}
          {days.length > 10 ? <li className="is-more">+{days.length - 10} dias</li> : null}</ol>
        <small>Previsão aproximada: o número exato de cada dia é sorteado na hora, e só entram os números com WhatsApp.</small>
      </div> : null}
    </>}
  </section>;
}
