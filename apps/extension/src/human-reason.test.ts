import { expect, it } from 'vitest';
import { humanReason } from './human-reason';
it('explains known technical reasons without changing the human queue', () => {
 expect(humanReason('automated_reception_wait')).toBe('O contato respondeu com um atendimento automático. Confira a conversa.');
 expect(humanReason('user_emergency_stop_all_ai')).toBe('A IA foi pausada por você. Revise a conversa antes de retomar o atendimento.');
 expect(humanReason('Prospecting binding requires review: review')).toBe('O vínculo desta conversa com a prospecção precisa ser revisado no Talk.');
 expect(humanReason('recusa')).toBe('O contato recusou a abordagem. Confira a conversa antes de continuar.');
});
it('preserves clear reasons and hides unknown internal codes', () => {
 expect(humanReason('Cliente pediu atendimento humano.')).toBe('Cliente pediu atendimento humano.');
 expect(humanReason('buyer_recap_review')).toBe('O resumo da negociação precisa da sua revisão.');
 expect(humanReason('unknown_internal_code')).toBe('Esta conversa precisa da sua atenção. Abra para conferir o contexto.');
 expect(humanReason(null)).toBe('Esta conversa precisa da sua atenção. Abra para conferir o contexto.');
});
