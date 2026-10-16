import type { CampanhaDeProspeccao, FichaDoLead } from "./tipos.js";

export function fichaInicial(): FichaDoLead {
  return {
    etapa: "abordado",
    contato: { nome: null, papel: "desconhecido", ehRobo: false },
    respondeu: false,
    interesse: "desconhecido",
    dor: null,
    objecao: null,
    perguntasDoLead: [],
    indicado: null,
    aceite: null,
    propostasDoObjetivo: 0,
    retomadas: 0
  };
}

export function renderFicha(ficha: FichaDoLead): string {
  return [
    `Etapa: ${ficha.etapa} · interesse: ${ficha.interesse}`,
    `Contato: ${ficha.contato.nome ?? "nome desconhecido"} (${ficha.contato.papel})${ficha.contato.ehRobo ? " · do outro lado já respondeu um robô de recepção" : ""}`,
    ...(ficha.dor ? [`O que o lead contou da rotina dele: ${ficha.dor}`] : []),
    ...(ficha.objecao ? [`Objeção: ${ficha.objecao.texto}${ficha.objecao.tratada ? " (já respondida uma vez)" : ""}`] : []),
    ...(ficha.perguntasDoLead.length ? [`Perguntas do lead sem resposta: ${ficha.perguntasDoLead.join(" | ")}`] : []),
    ...(ficha.indicado ? [`Indicou: ${ficha.indicado.nome}${ficha.indicado.contato ? ` (${ficha.indicado.contato})` : ""}`] : []),
    ...(ficha.aceite ? [`Aceitou: ${ficha.aceite}`] : []),
    `Objetivo já proposto ${ficha.propostasDoObjetivo} vez(es) · retomadas: ${ficha.retomadas}`
  ].join("\n");
}

export function renderCampanha(campanha: CampanhaDeProspeccao): string {
  return [
    `Nós: ${campanha.nossaEmpresa.nome}. ${campanha.nossaEmpresa.oQueFazemos}`,
    `Objetivo: ${campanha.objetivo}`,
    `O que podemos dizer da oferta: ${campanha.contextoDaOferta}`,
    ...(campanha.exemploDeDor ? [`Exemplo de dor: ${campanha.exemploDeDor}`] : []),
    `Lead: empresa ${campanha.lead.empresa}${campanha.lead.nomeContato ? `, contato ${campanha.lead.nomeContato}` : " (nome da pessoa desconhecido)"}`
  ].join("\n");
}
