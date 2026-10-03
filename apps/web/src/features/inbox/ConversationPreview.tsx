import { CameraIcon, FileTextIcon, MicrophoneIcon, StickerIcon, VideoCameraIcon, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import type { ConversationDto, ConversationLastMessageKind } from '@prymeira-talk/shared';
import { MessageTicks } from './MessageTicks';

type MediaKind = Exclude<ConversationLastMessageKind, 'text'>;
const labels: Record<MediaKind, string> = { sticker: 'Figurinha', image: 'Foto', video: 'Vídeo', audio: 'Áudio', file: 'Documento' };
// Placeholder bodies say "recebida" even for what we sent; the card names the kind instead, like WhatsApp.
const placeholders: Record<string, MediaKind> = {
  'Figurinha recebida': 'sticker', 'Figurinha enviada': 'sticker', 'Imagem recebida': 'image', 'Imagem enviada': 'image',
  'Vídeo recebido': 'video', 'Vídeo enviado': 'video', 'Áudio recebido': 'audio', 'Áudio enviado': 'audio',
  'Arquivo recebido': 'file', 'Arquivo enviado': 'file', 'Documento recebido': 'file', 'Documento enviado': 'file'
};

export function conversationPreview(conversation: Pick<ConversationDto, 'lastMessagePreview' | 'lastMessage'>): { kind: MediaKind | null; text: string } {
  const text = conversation.lastMessagePreview?.trim() ?? '';
  const placeholder = placeholders[text];
  const declared = conversation.lastMessage?.kind;
  const kind = placeholder ?? (declared && declared !== 'text' ? declared : null);
  if (!text) return { kind, text: kind ? labels[kind] : 'Conversa iniciada.' };
  return { kind, text: placeholder ? labels[placeholder] : text };
}

// Phosphor's filled glyphs read like WhatsApp's solid media icons.
const icons: Record<MediaKind, PhosphorIcon> = { sticker: StickerIcon, image: CameraIcon, video: VideoCameraIcon, audio: MicrophoneIcon, file: FileTextIcon };

export function ConversationPreview({ conversation }: { conversation: Pick<ConversationDto, 'lastMessagePreview' | 'lastMessage'> }) {
  const { kind, text } = conversationPreview(conversation);
  const Icon = kind ? icons[kind] : null;
  return <span className="conversation-preview">
    {conversation.lastMessage?.direction === 'outbound' ? <MessageTicks status={conversation.lastMessage.status} /> : null}
    {Icon ? <Icon className="conversation-preview-kind" size={15} weight="fill" aria-hidden="true" /> : null}
    <span className="conversation-preview-text">{text}</span>
  </span>;
}
