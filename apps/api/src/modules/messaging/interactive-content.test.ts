import { describe, expect, it } from 'vitest';
import { interactiveMessageText } from './interactive-content.js';
import { gowsMessageToWpp } from '../waha/waha-gows.js';
import { wahaContent } from '../waha/waha-content.js';
import { extractMessageContent, extractPushName } from '../evolution/evolution-normalizer.js';

const claro = { interactiveMessage: {
  header: { hasMediaAttachment: true, documentMessage: { fileName: 'Fatura.pdf', mimetype: 'application/pdf' } },
  body: { text: 'Olá, eu sou o Assistente virtual da Claro' }, footer: { text: 'Claro' },
  nativeFlowMessage: { buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Ver fatura","id":"1"}' }, { name: 'cta_url', buttonParamsJson: '{"display_text":"Abrir site"}' }] } } };

describe('business and interactive messages read like WhatsApp shows them', () => {
  it('reads an interactive message with a document header, its body, footer and buttons', () => {
    expect(interactiveMessageText(claro)).toBe('📄 Fatura.pdf\nOlá, eu sou o Assistente virtual da Claro\nClaro\nOpções: Ver fatura · Abrir site');
  });
  it('reads templates, buttons, lists, replies, polls, events and invites', () => {
    expect(interactiveMessageText({ templateMessage: { hydratedTemplate: { hydratedTitleText: 'Pedido 42', hydratedContentText: 'Seu pedido saiu', hydratedButtons: [{ quickReplyButton: { displayText: 'Rastrear' } }] } } }))
      .toBe('Pedido 42\nSeu pedido saiu\nOpções: Rastrear');
    expect(interactiveMessageText({ buttonsMessage: { contentText: 'Escolha', buttons: [{ buttonText: { displayText: 'Sim' } }, { buttonText: { displayText: 'Não' } }] } })).toBe('Escolha\nOpções: Sim · Não');
    expect(interactiveMessageText({ listMessage: { title: 'Menu', description: 'Selecione', buttonText: 'Abrir', sections: [{ rows: [{ title: 'Boletos' }, { title: 'Suporte' }] }] } })).toBe('Menu\nSelecione\nOpções: Boletos · Suporte');
    expect(interactiveMessageText({ buttonsResponseMessage: { selectedDisplayText: 'Sim' } })).toBe('Sim');
    expect(interactiveMessageText({ listResponseMessage: { title: 'Suporte' } })).toBe('Suporte');
    expect(interactiveMessageText({ pollCreationMessageV3: { name: 'Churras sábado?', options: [{ optionName: 'Vou' }, { optionName: 'Não vou' }] } })).toBe('📊 Enquete: Churras sábado?\n○ Vou\n○ Não vou');
    expect(interactiveMessageText({ eventMessage: { name: 'Aniversário', description: 'Às 20h' } })).toBe('📅 Evento: Aniversário\nÀs 20h');
    expect(interactiveMessageText({ groupInviteMessage: { groupName: 'Padel' } })).toBe('👥 Convite para o grupo Padel');
  });
  it('reads a shared Pix key (payment_info) from Evolution and from GOWS', () => {
    const params = JSON.stringify({ currency: 'BRL', total_amount: { value: 0, offset: 100 }, payment_settings: [{ type: 'pix_static_code',
      pix_static_code: { merchant_name: 'MALAH GESTORA FINANCEIRA', key: 'financeiro@villefer.com.br', key_type: 'EMAIL' } }] });
    const expected = '💠 Chave Pix\nMALAH GESTORA FINANCEIRA\nE-mail: financeiro@villefer.com.br';
    expect(extractMessageContent({ interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJson: params }] } } })).toMatchObject({ type: 'text', body: expected });
    // Shape observed in production (GOWS 2026.9.1): the proto oneof wrapper and buttonParamsJSON.
    const gows = gowsMessageToWpp({ id: 'false_1@lid_A', from: '1@lid', fromMe: false, _data: { Info: { ID: 'A', Chat: '1@lid', IsFromMe: false },
      Message: { interactiveMessage: { InteractiveMessage: { NativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJSON: params.replace('"value":0', '"value":12345') }] } } } } } });
    expect(wahaContent(gows).content.body).toBe('💠 Chave Pix\nMALAH GESTORA FINANCEIRA\nValor: R$\u00a0123,45\nE-mail: financeiro@villefer.com.br');
  });
  it('GOWS: an encrypted poll vote is a vote on its poll', () => {
    const gows = gowsMessageToWpp({ id: 'true_1@g.us_V', from: '1@g.us', fromMe: true, _data: { Info: { ID: 'V', Chat: '1@g.us', IsFromMe: true },
      Message: { pollUpdateMessage: { pollCreationMessageKey: { ID: 'POLL1' }, vote: { encPayload: 'x' } } } } });
    expect(wahaContent(gows).content).toMatchObject({ type: 'system', body: 'Votou na enquete', pollVote: { targetId: 'POLL1', options: null } });
  });
  it('Evolution: a template with its text only in an interactive template is no longer "Template recebido sem texto"', () => {
    const template = { templateMessage: { hydratedTemplate: { documentMessage: { fileName: 'Fatura.pdf' }, hydratedContentText: '' }, interactiveMessageTemplate: { body: { text: 'Sua fatura chegou' } } } };
    expect(extractMessageContent(template)).toMatchObject({ type: 'template', body: '📄 Fatura.pdf\nSua fatura chegou' });
  });
  it('leaves what it cannot read to the caller', () => {
    expect(interactiveMessageText({ protocolMessage: { type: 0 } })).toBeNull();
    expect(interactiveMessageText({ conversation: 'oi' })).toBeNull();
  });
  it('GOWS: the interactive text becomes the message and the verified business name names the contact', () => {
    const wpp = gowsMessageToWpp({ id: 'x', from: '182364311425240@lid', fromMe: false, _data: {
      Info: { IsFromMe: false, PushName: '', VerifiedName: { Details: { verifiedName: 'Minha Claro' } } },
      Message: { InteractiveMessage: { Body: { Text: 'Olá, eu sou o Assistente virtual da Claro' } } } } });
    const data = wpp._data as Record<string, unknown>;
    expect(data.notifyName).toBe('Minha Claro');
    expect(wahaContent(wpp).content).toMatchObject({ type: 'text', body: 'Olá, eu sou o Assistente virtual da Claro' });
  });
  it('Evolution: same text, and verifiedBizName when there is no push name', () => {
    expect(extractMessageContent(claro)).toMatchObject({ type: 'text', preview: expect.stringContaining('Assistente virtual da Claro') });
    expect(extractPushName({ data: { verifiedBizName: 'Minha Claro' } })).toBe('Minha Claro');
  });
});
