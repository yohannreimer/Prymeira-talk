import type { ConversationDto, MessageDto } from '@prymeira-talk/shared';

const WIDTH = 1000;
const MAX_HEIGHT = 4000;
const HEADER_HEIGHT = 164;
const FOOTER_HEIGHT = 66;
const BUBBLE_WIDTH = 820;
const TEXT_WIDTH = BUBBLE_WIDTH - 56;
const LINE_HEIGHT = 31;

type ContextMessage = Pick<MessageDto, 'id' | 'direction' | 'type' | 'body' | 'attachment' | 'status' | 'createdAt'>;
type LaidOutMessage = { message: ContextMessage; lines: string[]; height: number };

export function selectRecentContextMessages(messages: ContextMessage[]): ContextMessage[] {
  return messages.filter((message) =>
    message.type !== 'internal_note' && message.type !== 'system' && message.status !== 'failed' && message.status !== 'pending'
  ).slice(-14);
}

function displayText(message: ContextMessage): string {
  const body = message.body?.trim() || message.attachment?.caption?.trim() || '';
  if (message.type === 'audio') return body && !/^áudio (recebido|enviado)$/i.test(body) ? `Áudio: ${body}` : 'Áudio';
  if (message.type === 'image') return body ? `Imagem: ${body}` : 'Imagem';
  if (message.type === 'file') return body ? `Arquivo: ${body}` : 'Arquivo';
  return body || 'Mensagem sem texto';
}

function wrapText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines = 36): string[] {
  const lines: string[] = [];
  const text = value.slice(0, 2200);
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (ctx.measureText(`${line}${character}`).width > maxWidth && line) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  if (lines.length > maxLines || value.length > text.length) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]?.replace(/\s*…?$/, '') ?? ''}…`;
    return kept;
  }
  return lines.length ? lines : ['Mensagem sem texto'];
}

function messageDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

export function createConversationContextImages(
  messages: ContextMessage[],
  source: Pick<ConversationDto, 'contactName' | 'contactPhone'>
): Array<{ fileName: string; mediaUrl: string; mimetype: 'image/png' }> {
  const recent = selectRecentContextMessages(messages);
  if (!recent.length) return [];

  const measuringCanvas = document.createElement('canvas');
  const measuringContext = measuringCanvas.getContext('2d');
  if (!measuringContext) throw new Error('Este navegador não conseguiu criar a imagem do histórico.');
  measuringContext.font = '23px Arial, sans-serif';
  const layouts: LaidOutMessage[] = recent.map((message) => {
    const lines = wrapText(measuringContext, displayText(message), TEXT_WIDTH);
    return { message, lines, height: 100 + lines.length * LINE_HEIGHT };
  });

  const pages: LaidOutMessage[][] = [];
  let page: LaidOutMessage[] = [];
  let usedHeight = HEADER_HEIGHT + FOOTER_HEIGHT + 26;
  for (const layout of layouts) {
    if (page.length && usedHeight + layout.height + 18 > MAX_HEIGHT) {
      pages.push(page);
      page = [];
      usedHeight = HEADER_HEIGHT + FOOTER_HEIGHT + 26;
    }
    page.push(layout);
    usedHeight += layout.height + 18;
  }
  if (page.length) pages.push(page);

  const contact = source.contactName?.trim() || source.contactPhone || 'Contato';
  return pages.map((items, index) => {
    const height = HEADER_HEIGHT + FOOTER_HEIGHT + 26 + items.reduce((sum, item) => sum + item.height + 18, 0);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Este navegador não conseguiu criar a imagem do histórico.');

    ctx.fillStyle = '#e9f1ed';
    ctx.fillRect(0, 0, WIDTH, height);
    ctx.fillStyle = '#23594b';
    ctx.fillRect(0, 0, WIDTH, HEADER_HEIGHT);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px Arial, sans-serif';
    ctx.fillText('Histórico recente da conversa', 48, 58);
    ctx.font = '23px Arial, sans-serif';
    ctx.fillText(contact.slice(0, 46), 48, 101);
    ctx.font = '18px Arial, sans-serif';
    ctx.fillText(`${source.contactPhone || ''}  ·  ${recent.length} mensagens`, 48, 135);

    let y = HEADER_HEIGHT + 26;
    for (const { message, lines, height: bubbleHeight } of items) {
      const outbound = message.direction === 'outbound';
      const x = outbound ? WIDTH - 48 - BUBBLE_WIDTH : 48;
      ctx.fillStyle = outbound ? '#d5eee0' : '#ffffff';
      drawRoundedRect(ctx, x, y, BUBBLE_WIDTH, bubbleHeight, 18);
      ctx.fillStyle = '#295a4c';
      ctx.font = 'bold 18px Arial, sans-serif';
      ctx.fillText(outbound ? 'Atendimento' : 'Cliente', x + 28, y + 36);
      ctx.fillStyle = '#19322a';
      ctx.font = '23px Arial, sans-serif';
      lines.forEach((line, lineIndex) => ctx.fillText(line, x + 28, y + 76 + lineIndex * LINE_HEIGHT));
      ctx.fillStyle = '#627970';
      ctx.font = '17px Arial, sans-serif';
      ctx.fillText(messageDate(message.createdAt), x + 28, y + bubbleHeight - 19);
      y += bubbleHeight + 18;
    }

    ctx.fillStyle = '#49685c';
    ctx.font = '18px Arial, sans-serif';
    ctx.fillText(`Gerado pelo Prymeira Talk  ·  ${index + 1}/${pages.length}`, 48, height - 26);
    const mediaUrl = canvas.toDataURL('image/png');
    if (mediaUrl.length > 10 * 1024 * 1024) throw new Error('A imagem do histórico ficou grande demais para enviar.');
    return { fileName: `historico-conversa-${index + 1}.png`, mediaUrl, mimetype: 'image/png' as const };
  });
}
