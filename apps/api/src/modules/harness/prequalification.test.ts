import {describe,it,expect} from 'vitest';
import {fichaInicial,renderFicha} from './agentes/atendimento/ficha.js';
import {decidirJogada,aposEnvio} from './agentes/atendimento/jogadas.js';
import {ferramentasDeLeitura} from './agentes/atendimento/ferramentas.js';
import {regras} from './agentes/atendimento/regras.js';
import type {FichaDoAtendimento} from './agentes/atendimento/tipos.js';
const pedido={empresa:{nome:'Distribuidora',oQueVende:'Chapas'},maxFollowups:2};
const evento={tipo:'mensagem' as const,texto:'Preciso de chapa inox de 2 mm. Qual o preço?'};
const ficha=():FichaDoAtendimento=>({...fichaInicial(),perguntas:[{id:'q1',texto:'Qual o preço?',status:'sem_base',resposta:null,buscas:1}],prequalificacao:{situacao:'coletando',resumo:'Chapa inox solicitada',faltantes:['medida','quantidade','cidade'],divergencias:['Preço a definir no orçamento']}});
describe('prequalification owns the conversation',()=>{
 it.each(['O vendedor pode avaliar essa quantidade.','O frete o vendedor confirma.','O comercial vai confirmar a liga.','O responsável avalia.'])("blocks delegation during collection: %s",texto=>{
  const rule=regras.find(r=>r.id==='sem_terceirizar_prequalificacao')!;
  expect(rule.check({texto,ficha:ficha(),pedido,historico:[],jogada:{tipo:'qualificar_com_pendencias',instrucao:''}})).toMatchObject({ok:false});
 });
 it('keeps unresolved price in the internal record without an automatic handoff',()=>{
  const f=ficha(),jogada=decidirJogada({ficha:f,pedido,triagem:null,evento});
  expect(jogada.avisarHumano).toBeUndefined();
  expect(aposEnvio({ficha:f,jogada,texto:'O valor será definido no orçamento. Qual medida você precisa?'}).perguntas[0].status).toBe('sem_base');
  expect(renderFicha(f)).toContain('Preço a definir no orçamento');
 });
 it('hands off only once qualification has no customer data missing',()=>{
  const f=ficha();f.prequalificacao={situacao:'pronta',resumo:'Pedido completo para orçamento',faltantes:[],divergencias:['A36 solicitado, norma a conferir']};
  const j=decidirJogada({ficha:f,pedido,triagem:null,evento});
  expect(j.tipo).toBe('prequalificacao_pronta');expect(j.avisarHumano).toContain('A36 solicitado');
 });
 it('rejects a ready qualification while customer data is still missing',()=>{
  const tool=ferramentasDeLeitura.find(t=>t.name==='registrar_prequalificacao')!;
  expect(()=>tool.execute({situacao:'pronta',resumo:'Pedido',faltantes:['cidade'],divergencias:[]} as never,{ficha:ficha(),pedido,historico:[],mensagemAtual:'',setFicha:()=>{}})).toThrow(/faltantes/);
 });
 it('still allows mentioning the transfer when an actual handoff is happening',()=>{
  const rule=regras.find(r=>r.id==='sem_terceirizar_prequalificacao')!;
  expect(rule.check({texto:'Reuni os dados e vou encaminhar ao responsável pelo orçamento.',ficha:ficha(),pedido,historico:[],jogada:{tipo:'prequalificacao_pronta',instrucao:'',avisarHumano:'Pedido pronto'}})).toMatchObject({ok:true});
 });
});
