// Source contract: WhatsApp's WAProto (Baileys/whatsmeow) as camelCase JSON — the shape Evolution sends and the shape
// GOWS events take after WAHA's GoToJSWAProto. Business and interactive messages carry their text in nested fields.

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const lines = (...parts: Array<string | null | undefined>) => parts.filter((part): part is string => Boolean(part)).join('\n') || null;

/** Labels of the buttons WhatsApp draws under a business message ("Opções: Falar com atendente · Ver fatura"). */
function buttons(values: Array<string | null>) {
  const labels = values.filter((value): value is string => Boolean(value)).slice(0, 10);
  return labels.length ? `Opções: ${labels.join(' · ')}` : null;
}

/** A document/picture/clip attached on top of a business message, shown as a line since only its text is read. */
function headerMedia(source: Obj) {
  const document = obj(source.documentMessage);
  if (Object.keys(document).length) return `📄 ${text(document.fileName) ?? text(document.title) ?? 'Documento'}`;
  if (Object.keys(obj(source.imageMessage)).length) return '📷 Foto';
  if (Object.keys(obj(source.videoMessage)).length) return '🎥 Vídeo';
  if (Object.keys(obj(source.locationMessage)).length) return '📍 Localização';
  return null;
}

function nativeFlowLabel(button: unknown) {
  const params = text(obj(button).buttonParamsJson);
  if (!params) return null;
  try { return text(obj(JSON.parse(params)).display_text); } catch { return null; }
}

/**
 * The text WhatsApp shows for a message that is not plain text or media: business templates, buttons, lists,
 * interactive (native flow) messages, the replies to them, polls, events and group invites. Null when the message is
 * none of those, so the caller keeps its "Mensagem não reconhecida" for what really cannot be read.
 */
export function interactiveMessageText(message: unknown): string | null {
  const m = obj(message);

  const template = obj(m.templateMessage);
  if (Object.keys(template).length) {
    const t = obj(template.hydratedTemplate ?? template.hydratedFourRowTemplate ?? template.fourRowTemplate);
    const native = obj(template.interactiveMessageTemplate);
    const nativeText = Object.keys(native).length ? interactiveMessageText({ interactiveMessage: native }) : null;
    if (!Object.keys(t).length) return nativeText;
    return lines(headerMedia(t), text(t.hydratedTitleText), text(t.hydratedContentText), nativeText,
      text(t.hydratedFooterText), buttons(list(t.hydratedButtons).map(button => {
        const b = obj(button);
        return text(obj(b.quickReplyButton).displayText) ?? text(obj(b.urlButton).displayText) ?? text(obj(b.callButton).displayText);
      })));
  }

  const interactive = obj(m.interactiveMessage);
  if (Object.keys(interactive).length) {
    const header = obj(interactive.header);
    return lines(headerMedia(header), text(header.title), text(header.subtitle), text(obj(interactive.body).text), text(obj(interactive.footer).text),
      buttons(list(obj(interactive.nativeFlowMessage).buttons).map(nativeFlowLabel)),
      Object.keys(obj(interactive.collectionMessage)).length || Object.keys(obj(interactive.shopStorefrontMessage)).length ? '🛍️ Catálogo' : null);
  }

  const buttonsMessage = obj(m.buttonsMessage);
  if (Object.keys(buttonsMessage).length) {
    return lines(headerMedia(buttonsMessage), text(buttonsMessage.text), text(buttonsMessage.contentText), text(buttonsMessage.footerText),
      buttons(list(buttonsMessage.buttons).map(button => text(obj(obj(button).buttonText).displayText) ?? nativeFlowLabel(obj(button).nativeFlowInfo))));
  }

  const listMessage = obj(m.listMessage);
  if (Object.keys(listMessage).length) {
    const rows = list(listMessage.sections).flatMap(section => list(obj(section).rows).map(row => text(obj(row).title)));
    return lines(text(listMessage.title), text(listMessage.description), text(listMessage.footerText),
      buttons(rows.length ? rows : [text(listMessage.buttonText)]));
  }

  // The customer's answer to one of the above: WhatsApp shows the option they picked.
  const reply = text(obj(m.buttonsResponseMessage).selectedDisplayText) ?? text(obj(m.templateButtonReplyMessage).selectedDisplayText)
    ?? text(obj(m.listResponseMessage).title) ?? text(obj(obj(m.interactiveResponseMessage).body).text);
  if (reply) return reply;

  const poll = obj(m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3 ?? m.pollCreationMessageV5);
  if (Object.keys(poll).length) {
    const options = list(poll.options).map(option => text(obj(option).optionName)).filter((option): option is string => Boolean(option));
    return lines(`📊 Enquete: ${text(poll.name) ?? 'sem título'}`, ...options.slice(0, 12).map(option => `○ ${option}`));
  }

  const event = obj(m.eventMessage);
  if (Object.keys(event).length) return lines(`📅 Evento: ${text(event.name) ?? 'sem título'}`, text(event.description));

  const invite = obj(m.groupInviteMessage);
  if (Object.keys(invite).length) return lines(`👥 Convite para o grupo ${text(invite.groupName) ?? ''}`.trim(), text(invite.caption));

  const product = obj(obj(m.productMessage).product);
  if (Object.keys(product).length) return lines(`🛍️ ${text(product.title) ?? 'Produto'}`, text(product.description));
  if (Object.keys(obj(m.orderMessage)).length) return lines('🛒 Pedido', text(obj(m.orderMessage).message));
  if (Object.keys(obj(m.requestPhoneNumberMessage)).length) return 'Pediu o seu número de telefone';
  return null;
}
