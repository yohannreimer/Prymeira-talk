import { narrarEvento, narrarTurno, type Passo } from "../core/narrador.js";
import type { HarnessMessage } from "../core/types.js";
import type { Check, ScenarioRun } from "./simulador.js";

export type EntradaDaLinha = {
  id: string;
  titulo: string;
  tentativa: number;
  run: ScenarioRun<unknown, unknown>;
  checks: Check[];
};

const FASE: Record<Passo["fase"], string> = {
  triagem: "Triagem",
  leitura: "Leitura",
  analise: "Análise",
  jogada: "Decisão",
  escrita: "Escrita",
  revisao: "Revisão",
  envio: "Envio",
  humano: "Pessoa",
  silencio: "Silêncio"
};

/**
 * A self-contained page that shows each conversation as the owner would read it: the contact's
 * message, then what the agent did behind the scenes (triage, tools and their results, the move and
 * why, the text, the review), then what was sent or who took over.
 */
export function renderLinhaDoTempoHtml(input: { agente: string; modelo: string; geradoEm?: string; entradas: EntradaDaLinha[] }) {
  const falhas = input.entradas.filter((entrada) => !passou(entrada)).length;
  const indice = input.entradas
    .map((entrada) => `<li><a href="#${ancora(entrada)}"><span class="dot ${passou(entrada) ? "ok" : "erro"}"></span>${esc(entrada.titulo)}${input.entradas.some((outra) => outra !== entrada && outra.id === entrada.id) ? ` <small>tentativa ${entrada.tentativa}</small>` : ""}</a></li>`)
    .join("");
  return `<title>Linha do tempo · ${esc(input.agente)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
<main>
  <header class="topo">
    <p class="rotulo">Rastro do agente · ${esc(input.agente)}</p>
    <h1>O que o agente viu, pensou e fez</h1>
    <p class="lead">Cada conversa aparece como no WhatsApp. Entre as mensagens fica o que aconteceu nos bastidores: como ele classificou a mensagem, que ferramentas usou e o que elas devolveram, que jogada o código escolheu e por quê, o que ele escreveu e o que o revisor achou.</p>
    <p class="nota">O raciocínio interno do modelo não é devolvido pela API, então não aparece. O que aparece são as decisões e o motivo de cada uma, que é onde dá para ver onde ele se perdeu.</p>
    <dl class="resumo">
      <div><dt>Conversas</dt><dd>${input.entradas.length}</dd></div>
      <div><dt>Com problema</dt><dd class="${falhas ? "txt-erro" : ""}">${falhas}</dd></div>
      <div><dt>Modelo</dt><dd class="mono">${esc(input.modelo)}</dd></div>
      ${input.geradoEm ? `<div><dt>Gerado em</dt><dd>${esc(input.geradoEm)}</dd></div>` : ""}
    </dl>
    <div class="filtro" role="group" aria-label="Filtrar conversas">
      <button type="button" data-filtro="todas" aria-pressed="true">Todas</button>
      <button type="button" data-filtro="falhas" aria-pressed="false">Só as com problema</button>
    </div>
    <nav><ol class="indice">${indice}</ol></nav>
  </header>
  ${input.entradas.map(renderEntrada).join("\n")}
</main>
<script>${JS}</script>`;
}

function renderEntrada(entrada: EntradaDaLinha) {
  const ok = passou(entrada);
  const run = entrada.run;
  const checks = entrada.checks
    .map((check) => `<li class="${check.ok ? "ok" : "erro"}"><span>${check.ok ? "✓" : "✗"}</span><div><b>${esc(check.nome.replace(/_/g, " "))}</b>${!check.ok && check.detalhe ? `<p>${esc(check.detalhe)}</p>` : ""}</div></li>`)
    .join("");
  const antes = run.historicoInicial.length
    ? `<div class="passado"><p class="marco">Conversa que já existia</p>${run.historicoInicial.map((msg) => bolha(msg, true)).join("")}</div>`
    : "";
  // An opening the agent is not allowed to make (attendance only answers) is noise on the page.
  const visiveis = run.turnos.filter((turno) => !(turno.acontecimento.tipo === "abertura" && turno.resultado.jogada?.silencio));
  const turnos = visiveis.map((turno, index) => {
    const passos = narrarTurno(turno.resultado);
    const temProblema = passos.some((passo) => passo.tipo === "erro" || passo.tipo === "alerta");
    const contato = turno.acontecimento.tipo === "mensagem" ? bolha({ autor: "contato", texto: turno.acontecimento.texto }) : "";
    const marco = turno.acontecimento.tipo === "mensagem" ? "" : `<p class="marco">${esc(narrarEvento(turno.acontecimento))}</p>`;
    const enviado = turno.resultado.enviar ? bolha({ autor: "agente", texto: turno.resultado.enviar }) : "";
    const humano = turno.resultado.humano
      ? `<div class="passagem"><b>Passou para uma pessoa</b><p>${esc(turno.resultado.humano.motivo)}</p></div>`
      : "";
    return `${marco}${contato}
      <details class="bastidor${temProblema ? " atencao" : ""}"${!ok || temProblema ? " open" : ""}>
        <summary><span>Bastidores da vez ${index + 1}</span><span class="jogada">${esc((turno.resultado.jogada?.tipo ?? "sem jogada").replace(/_/g, " "))}</span></summary>
        <ol class="passos">${passos.map(renderPasso).join("")}</ol>
      </details>${enviado}${humano}`;
  }).join("\n");
  return `<section class="conversa" id="${ancora(entrada)}" data-ok="${ok}">
    <header>
      <h2>${esc(entrada.titulo)}</h2>
      <p class="selo ${ok ? "ok" : "erro"}">${ok ? "Passou" : "Teve problema"}${entrada.tentativa > 1 ? ` · tentativa ${entrada.tentativa}` : ""}</p>
    </header>
    <div class="fio">${antes}${turnos}${run.erro ? `<div class="passagem erro"><b>Quebrou</b><p>${esc(run.erro)}</p></div>` : ""}</div>
    <details class="conferencia"${ok ? "" : " open"}><summary>O que o teste conferiu</summary><ul>${checks}</ul></details>
  </section>`;
}

function renderPasso(passo: Passo) {
  return `<li class="passo ${passo.tipo}">
    <span class="fase">${FASE[passo.fase]}</span>
    <div class="corpo"><p class="titulo">${esc(passo.titulo)}${passo.ms !== undefined && passo.ms >= 50 ? ` <small>${(passo.ms / 1000).toFixed(1)} s</small>` : ""}</p>${passo.detalhe ? `<p class="detalhe">${esc(passo.detalhe)}</p>` : ""}</div>
  </li>`;
}

function bolha(msg: Pick<HarnessMessage, "autor" | "texto">, passado = false) {
  const quem = msg.autor === "agente" ? "Agente" : msg.autor === "contato" ? "Contato" : "Vendedor";
  return `<div class="msg ${msg.autor === "contato" ? "deles" : "nossa"}${passado ? " antiga" : ""}"><span>${quem}</span><p>${esc(msg.texto)}</p></div>`;
}

function passou(entrada: EntradaDaLinha) {
  return !entrada.run.erro && entrada.checks.every((check) => check.ok);
}

function ancora(entrada: EntradaDaLinha) {
  return `c-${entrada.id}-${entrada.tentativa}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function esc(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
:root{--bg:#f5f3ee;--surface:#fffdf8;--ink:#1f2421;--muted:#626a64;--line:#dcd8cd;--accent:#1f6f5c;--accent-soft:#e1efe9;
--ok:#2c7a4b;--ok-soft:#e3f1e7;--alerta:#9a6200;--alerta-soft:#f8ecd2;--erro:#b3372b;--erro-soft:#f7e1dd;
--deles:#ffffff;--nossa:#dcf3e4;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141816;--surface:#1c211e;--ink:#e6e8e3;--muted:#9aa39c;--line:#2f3631;--accent:#6cc2a7;--accent-soft:#1f3a31;
--ok:#7fcf9b;--ok-soft:#1d3426;--alerta:#e7b65a;--alerta-soft:#3a2f17;--erro:#f08a7e;--erro-soft:#3d1f1b;--deles:#232926;--nossa:#1e3b2e;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#141816;--surface:#1c211e;--ink:#e6e8e3;--muted:#9aa39c;--line:#2f3631;--accent:#6cc2a7;--accent-soft:#1f3a31;
--ok:#7fcf9b;--ok-soft:#1d3426;--alerta:#e7b65a;--alerta-soft:#3a2f17;--erro:#f08a7e;--erro-soft:#3d1f1b;--deles:#232926;--nossa:#1e3b2e;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5}
main{max-width:860px;margin:0 auto;padding-block:40px 80px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:40px}
h1,h2{text-wrap:balance;margin:0;line-height:1.2}
h1{font-size:clamp(26px,5vw,34px);font-weight:600;letter-spacing:-.01em}
h2{font-size:19px;font-weight:600}
.rotulo{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:600}
.lead{max-width:65ch;margin:14px 0 0;color:var(--ink)}
.nota{max-width:65ch;margin:10px 0 0;color:var(--muted);font-size:14px}
.resumo{display:flex;flex-wrap:wrap;gap:12px 32px;margin:22px 0 0;padding:14px 0;border-block:1px solid var(--line)}
.resumo dt{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.resumo dd{margin:2px 0 0;font-size:18px;font-weight:600}
.mono{font-family:var(--mono);font-size:14px!important;font-weight:500!important}
.txt-erro{color:var(--erro)}
.filtro{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
.filtro button{font:inherit;font-size:14px;padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
.filtro button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.indice{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:4px 16px}
.indice a{display:flex;align-items:center;gap:8px;padding:4px 0;color:var(--ink);text-decoration:none;font-size:14px}
.indice a:hover{color:var(--accent)}
.indice small{color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--ok)}
.dot.erro{background:var(--erro)}
.conversa{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px clamp(14px,3vw,26px);display:grid;gap:18px;scroll-margin-top:16px}
.conversa>header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.selo{margin:0;font-size:13px;font-weight:600;padding:2px 10px;border-radius:999px}
.selo.ok{background:var(--ok-soft);color:var(--ok)}
.selo.erro{background:var(--erro-soft);color:var(--erro)}
.fio{display:grid;gap:10px}
.passado{display:grid;gap:8px;padding-bottom:6px;border-bottom:1px dashed var(--line)}
.marco{margin:6px 0 0;text-align:center;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.msg{max-width:min(78%,520px);padding:8px 12px 9px;border-radius:12px;border:1px solid var(--line);min-width:0}
.msg span{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.msg p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.deles{background:var(--deles);justify-self:start;border-top-left-radius:4px}
.msg.nossa{background:var(--nossa);justify-self:end;border-top-right-radius:4px;border-color:transparent}
.msg.antiga{opacity:.7}
.bastidor{border-left:2px solid var(--line);margin-left:6px;padding-left:14px}
.bastidor.atencao{border-left-color:var(--alerta)}
.bastidor summary{cursor:pointer;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13px;color:var(--muted);list-style:none}
.bastidor summary::-webkit-details-marker{display:none}
.bastidor summary::before{content:"▸";transition:transform .15s}
.bastidor[open] summary::before{transform:rotate(90deg)}
.jogada{font-family:var(--mono);font-size:12px;background:var(--accent-soft);color:var(--accent);padding:1px 8px;border-radius:6px}
.passos{list-style:none;margin:10px 0 4px;padding:0;display:grid;gap:8px}
.passo{display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:start}
.fase{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:3px}
.corpo{min-width:0;border-radius:8px;padding:6px 10px}
.passo.ok .corpo{background:var(--ok-soft)}
.passo.alerta .corpo{background:var(--alerta-soft)}
.passo.erro .corpo{background:var(--erro-soft)}
.titulo{margin:0;font-weight:500}
.passo.ok .titulo{color:var(--ok)}
.passo.alerta .titulo{color:var(--alerta)}
.passo.erro .titulo{color:var(--erro)}
.titulo small{color:var(--muted);font-weight:400}
.detalhe{margin:2px 0 0;font-size:13.5px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.passagem{justify-self:center;max-width:90%;text-align:center;background:var(--alerta-soft);border-radius:10px;padding:8px 14px;font-size:14px}
.passagem b{color:var(--alerta)}
.passagem.erro{background:var(--erro-soft)}.passagem.erro b{color:var(--erro)}
.passagem p{margin:2px 0 0;overflow-wrap:anywhere}
.conferencia summary{cursor:pointer;font-size:14px;font-weight:500}
.conferencia ul{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:6px}
.conferencia li{display:flex;gap:8px;font-size:14px}
.conferencia li p{margin:2px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.conferencia li.ok span{color:var(--ok)}.conferencia li.erro span,.conferencia li.erro b{color:var(--erro)}
.conferencia li b{font-weight:500}
@media (max-width:520px){.passo{grid-template-columns:1fr;gap:2px}.msg{max-width:92%}}
`;

const JS = `
document.querySelectorAll('[data-filtro]').forEach(function(btn){
  btn.addEventListener('click',function(){
    var so=btn.getAttribute('data-filtro')==='falhas';
    document.querySelectorAll('[data-filtro]').forEach(function(b){b.setAttribute('aria-pressed',String(b===btn))});
    document.querySelectorAll('.conversa').forEach(function(s){s.hidden=so&&s.getAttribute('data-ok')==='true'});
  });
});
`;

/** The page as a standalone file (the simulator writes it to disk; the Artifact publisher adds its own skeleton). */
export function documentoHtml(fragmento: string) {
  return `<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragmento}\n</body>\n</html>\n`;
}
