import type { CampaignProgressDto } from "../../app/api";
import { shortDayKey } from "./campaign-rhythm";

function rate(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}

/** Day by day and city by city: what went out, what is still planned and who answered. */
export function CampaignTracking({ progress }: { progress: CampaignProgressDto }) {
  const days = progress.days ?? [];
  const cities = progress.cities ?? [];
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const replied = days.reduce((total, day) => total + day.replied, 0);
  if (!days.length && cities.length <= 1) return null;
  return <div className="campaign-tracking">
    {days.length ? <section aria-label="Envios por dia"><header><h3>Por dia</h3>
      <span>{replied} {replied === 1 ? "respondeu" : "responderam"} · {rate(replied, progress.sent)} das enviadas</span></header>
      <table><thead><tr><th>Dia</th><th>Enviadas</th><th>Previstas</th><th>Responderam</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.day} className={day.day === todayKey ? "is-today" : day.day > todayKey ? "is-future" : ""}>
          <td>{shortDayKey(day.day)}{day.day === todayKey ? <em>hoje</em> : null}</td>
          <td>{day.sent || "–"}</td><td>{day.planned || "–"}</td>
          <td>{day.replied ? <>{day.replied} <small>{rate(day.replied, day.sent)}</small></> : "–"}</td></tr>)}</tbody></table>
    </section> : null}
    {cities.length > 1 || (cities.length === 1 && cities[0]!.city !== "Sem cidade") ? <section aria-label="Envios por cidade"><header><h3>Por cidade</h3>
      <span>{cities.length} {cities.length === 1 ? "cidade" : "cidades"}</span></header>
      <table><thead><tr><th>Cidade</th><th>Na lista</th><th>Enviadas</th><th>Responderam</th></tr></thead>
        <tbody>{cities.map(city => <tr key={city.city} className={city.city === "Sem cidade" ? "is-future" : ""}>
          <td>{city.city}</td><td>{city.total}</td><td>{city.sent || "–"}</td>
          <td>{city.replied ? <>{city.replied} <small>{rate(city.replied, city.sent)}</small></> : "–"}</td></tr>)}</tbody></table>
    </section> : null}
  </div>;
}
