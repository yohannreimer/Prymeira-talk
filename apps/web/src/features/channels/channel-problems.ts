import type { ChannelDto, ChannelHealthDto } from "@prymeira-talk/shared";

export type ChannelProblem = {
  channelId: string;
  tone: "danger" | "warning" | "info";
  title: string;
  detail: string;
};

const order = { danger: 0, warning: 1, info: 2 } as const;

function labelOf(channel: ChannelDto) {
  return channel.displayName?.trim() || channel.phoneNumber?.trim() || "Canal";
}

export function describeChannelProblems(channels: ChannelDto[], health: ChannelHealthDto[], now: Date = new Date()): ChannelProblem[] {
  const byChannel = new Map(health.map((item) => [item.channelId, item]));
  const problems: ChannelProblem[] = [];
  for (const channel of channels) {
    if (channel.provider !== "evolution") continue;
    const label = labelOf(channel);
    const item = byChannel.get(channel.id);
    if (item?.state === "needs_qr") {
      problems.push({ channelId: channel.id, tone: "danger", title: `${label} precisa ser reconectado`,
        detail: "O WhatsApp desvinculou este número. Abra Canais e escaneie o QR para voltar a receber mensagens." });
    } else if (channel.status === "disconnected" || channel.status === "failed") {
      if (item?.state === "reconnecting") {
        problems.push({ channelId: channel.id, tone: "info", title: `${label} está reconectando`,
          detail: "O Talk está tentando reconectar sozinho. Se continuar assim, vamos avisar que é preciso escanear o QR." });
      } else {
        problems.push({ channelId: channel.id, tone: "danger", title: `${label} está desconectado`,
          detail: "Este número não recebe nem envia mensagens agora. Abra Canais e reconecte." });
      }
    } else if (item?.state === "silent") {
      const hours = item.lastInboundAt ? Math.max(1, Math.floor((now.getTime() - new Date(item.lastInboundAt).getTime()) / 3_600_000)) : null;
      problems.push({ channelId: channel.id, tone: "warning", title: `${label} pode estar sem receber mensagens`,
        detail: `${hours ? `Nenhuma mensagem recebida há ${hours} h. ` : ""}Se o celular está normal, abra Canais e use Reconectar.` });
    }
  }
  return problems.sort((a, b) => order[a.tone] - order[b.tone]);
}
