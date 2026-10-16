import type { PurchaseRequestDetailDto } from "@prymeira-talk/shared";
import type { PedidoDeCompra } from "../harness/agentes/comprador/tipos.js";

/**
 * The request as one supplier conversation sees it, in the buyer agent's own shape. Not called yet: the agent is wired
 * to real WhatsApp conversations in a later step. The ceiling and the competitors stay in `privado`, which never
 * reaches the model; the best competing total only counts the other suppliers.
 */
export function toBuyerAgentOrder(request: PurchaseRequestDetailDto, inviteId: string, company: { nome: string; descricao?: string }): PedidoDeCompra {
  const others = request.invites.filter((invite) => invite.id !== inviteId);
  const competingTotals = request.comparison.columns
    .filter((column) => column.inviteId !== inviteId && column.totalCents !== null && column.status !== "declined")
    .map((column) => column.totalCents!);
  const rules = { maxChoradinhas: 1, maxCobrancas: 2 };
  return {
    id: request.id,
    empresa: company,
    itens: request.items.map((item) => ({ id: item.id, descricao: item.description, quantidade: item.quantity, unidade: item.unit,
      ...(item.specification ? { especificacao: item.specification } : {}) })),
    prazoResposta: request.responseDeadline,
    dataEntrega: request.deliveryDeadline,
    cep: request.deliveryCep,
    ...(request.deliveryCity ? { cidade: request.deliveryCity } : {}),
    exigeNotaFiscal: request.requiresInvoice,
    ...(request.paymentPreference ? { pagamentoPreferido: request.paymentPreference } : {}),
    ...(request.notes ? { observacoes: request.notes } : {}),
    privado: {
      ...(request.budgetCeilingCents ? { teto: request.budgetCeilingCents / 100 } : {}),
      concorrentes: others.map((invite) => invite.supplier.name),
      melhorProposta: competingTotals.length ? { total: Math.min(...competingTotals) / 100 } : null,
      ...rules
    }
  };
}
