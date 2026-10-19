/** Deliberate opt-out language, limited to campaign prospecting conversations.
 * Softer answers ("agora não", "já temos") are left to the agent, which may still
 * be scheduling a better moment; these stop the AI outright. */
export function isExplicitProspectingRefusal(body: string | null | undefined) {
  const text = (body ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /\b(nao (tenho|temos) (mais )?interesse|sem interesse|nao (me|nos) interessa|nao (quero|queremos) (receber|mais receber|mais mensagens)|pare(m)? de (mandar|enviar)|nao (me )?(mande|envie)|remova (meu|o meu) (numero|contato)|(me )?(tire|tira|remova|exclua)(m)? (meu numero |o meu numero )?da (sua )?lista|nao (me )?(chame|ligue|incomode)(m)? mais|nao entre(m)? em contato|numero errado|(foi|e) engano|unsubscribe|stop)\b/.test(text);
}
