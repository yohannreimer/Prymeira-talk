import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichDraft, type RichDraftHandle } from './features/inbox/RichDraft';
import { VoiceRecorder } from './features/inbox/VoiceRecorder';
import { WhatsappText } from './features/inbox/whatsapp-text';
import './styles.css';
function Check() {
  const [draft, setDraft] = useState(''); const [sent, setSent] = useState('');
  const [conversation, setConversation] = useState(1); const [audio, setAudio] = useState('');
  const [format, setFormat] = useState({ bold: false, italic: false }); const ref = useRef<RichDraftHandle>(null);
  return <main style={{ maxWidth: 850, margin: '60px auto', padding: 24 }}>
    <h1>Compositor — teste local</h1><p>Nada é enviado ao WhatsApp. A gravação fica apenas neste navegador.</p>
    <button onClick={() => { setConversation(c => c + 1); setDraft(''); }}>Trocar conversa</button> <span>Conversa {conversation}</span>
    <form className="composer" onSubmit={e => { e.preventDefault(); setSent(draft); setDraft(''); }}>
      <div className="composer-toolbar">
        <button type="button" className="composer-tool" aria-label="Negrito" aria-pressed={format.bold} onMouseDown={e => e.preventDefault()} onClick={() => ref.current?.format('bold')}><b>B</b></button>
        <button type="button" className="composer-tool" aria-label="Itálico" aria-pressed={format.italic} onMouseDown={e => e.preventDefault()} onClick={() => ref.current?.format('italic')}><i>I</i></button>
        <button type="button" onClick={() => ref.current?.insertText('😊')}>Emoji</button>
        <button type="button" onClick={() => setDraft('Olá *cliente*, segue _cotação_.')}>Carregar sugestão</button>
        <VoiceRecorder key={conversation} disabled={false} onSend={async file => { setAudio(`${file.type}, ${file.size} bytes — simulado localmente`); }} />
      </div>
      <div className="composer-input-row"><RichDraft key={conversation} ref={ref} value={draft} onChange={setDraft} onFormatChange={setFormat} disabled={false} /><button type="submit" aria-label="Simular envio">Enviar teste</button></div>
    </form>
    <p>Texto que seria enviado:</p><pre aria-label="Texto serializado">{draft}</pre>
    <p>Mensagem simulada:</p><div className="msg-bubble-body"><WhatsappText text={sent} /></div><p>{audio}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Check />);
