import { describe, expect, it } from 'vitest';
import { createJuizDeAtendimento } from './agentes/atendimento/juiz.js';
import { fichaInicial } from './agentes/atendimento/ficha.js';
import { reviewMessage, type JudgeInput } from './core/review.js';
import { narrarTurno } from './core/narrador.js';
import type { JevClient } from './core/jev.js';

const evidencia='Chapa de piso de alumínio: sob encomenda, prazo de 5 a 10 dias úteis, tamanho padrão 1250x3000.';
const boa='Boa tarde! Tudo bem. Trabalhamos com chapa de piso de alumínio sob encomenda, no tamanho padrão de 1250 x 3000 mm, com prazo de 5 a 10 dias úteis. O pedido mínimo de alumínio é de aproximadamente 300 kg. Para preparar o orçamento, qual medida e quantidade você precisa e para qual cidade seria a entrega?';
function input(texto=boa): JudgeInput {
  return {texto,ficha:{...fichaInicial(),perguntas:[{id:'q1',texto:'Vcs vendem chapa de alumínio xadrez?',status:'respondida',buscas:1,resposta:{trechoId:'t1',citacao:evidencia}}]},pedido:{},fichaTexto:evidencia,historico:[{autor:'contato',texto:'Vcs vendem chapa de alumínio xadrez?',em:'2026-10-17T23:31:00Z'}],jogada:{tipo:'responder',instrucao:'O objetivo é deixar o pedido pronto para orçar: termine perguntando o que ainda falta para o vendedor orçar (produto, medida, quantidade, cidade de entrega). Pode oferecer catálogo ou vendedor depois de responder.'}};
}
function jev(choices: Record<string,string>={}): JevClient {
  return {ask:async (_state,questions)=>Object.fromEntries(Object.entries(questions).map(([key,q])=>[key,q.type==='choice'?{type:'choice',choice:choices[key]??Object.keys(q.criteria)[0]}:{type:'noul',noul:key==='inventa'?.14:key==='segue'?.45:.96}]))};
}
describe('attendance reviewer requirements',()=>{
  it('accepts the useful real reply despite the old low adherence score and no optional catalogue offer',async()=>{
    const result=await createJuizDeAtendimento(jev())(input());
    expect(result).toMatchObject({ok:true,verificacoes:expect.arrayContaining([expect.objectContaining({id:'encomenda_1',resultado:'preservada'}),expect.objectContaining({id:'resposta_1',resultado:'atendida'})])});
  });
  it('says exactly which condition was omitted with its question and source',async()=>{
    const result=await createJuizDeAtendimento(jev({encomenda_1:'omitida'}))(input('Trabalhamos com essa chapa. Qual medida, quantidade e cidade?'));
    expect(result).toMatchObject({ok:false,regra:'juiz_requisito',motivo:expect.stringMatching(/q1.*sob encomenda.*t1/s)});
  });
  it('identifies quantity when it is the missing next step',async()=>{
    expect(await createJuizDeAtendimento(jev({dado_quantidade:'faltou'}))(input())).toMatchObject({ok:false,motivo:expect.stringContaining('quantidade')});
  });
  it('identifies an unsupported price, independently of a generic hallucination score',async()=>{
    expect(await createJuizDeAtendimento(jev({afirmacao_sem_base:'preco'}))(input())).toMatchObject({ok:false,regra:'juiz_requisito',motivo:expect.stringContaining('preço')});
  });
  it('identifies which question remained unanswered',async()=>{
    const i=input(); const f=i.ficha as ReturnType<typeof fichaInicial>;
    f.perguntas.push({...f.perguntas[0],id:'q2',texto:'Qual o prazo?'});
    expect(await createJuizDeAtendimento(jev({resposta_2:'sem_resposta'}))(i)).toMatchObject({ok:false,motivo:expect.stringMatching(/q2.*Qual o prazo/s)});
  });
  it('preserves and renders the concrete rejection in the step-by-step trace',async()=>{
    const result=await reviewMessage({...input(),rules:[],judge:createJuizDeAtendimento(jev({encomenda_1:'omitida'}))});
    expect(result).toMatchObject({ok:false,verificacoes:expect.arrayContaining([expect.objectContaining({id:'encomenda_1',ok:false})])});
    const passos=narrarTurno({trace:[{fase:'revisao',detalhe:result}]});
    expect(passos[0].detalhe).toMatch(/encomenda_1.*sob encomenda/s);
  });
  it('fails closed for an unknown verdict instead of approving it',async()=>{
    const result=await reviewMessage({...input(),rules:[],judge:createJuizDeAtendimento(jev({encomenda_1:'desconhecido'}))});
    expect(result).toMatchObject({ok:false,regra:'juiz_indisponivel'});
  });
});
