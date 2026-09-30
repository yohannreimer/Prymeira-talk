/** Deliberate opt-out language, limited to campaign prospecting conversations. */
export function isExplicitProspectingRefusal(body: string | null | undefined) {
  const text = (body ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(nao (tenho|temos) interesse|nao (quero|queremos) (receber|mais receber|mais mensagens)|pare(m)? de (mandar|enviar)|nao (me )?(mande|envie)|remova (meu|o meu) (numero|contato)|nao entre(m)? em contato|unsubscribe|stop)\b/.test(text);
}
