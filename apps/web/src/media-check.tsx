import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { InboxMedia } from './features/inbox/InboxMedia';
import { ContactAvatar, ContactPhotoProvider } from './features/inbox/ContactAvatar';
import './styles.css';
const token = async () => 'fixture';
function Harness() {
  const [visible, setVisible] = useState(true);
  return <ContactPhotoProvider getToken={token}><main style={{maxWidth:760,margin:'30px auto',padding:20}}>
    <h2>Mídias — teste isolado</h2><p>Arquivos sintéticos. Nenhuma mensagem é enviada.</p>
    <div style={{display:'flex',gap:12,alignItems:'center',margin:'20px 0'}}><ContactAvatar conversationId="fixture" name="Ana Silva" className="conversation-avatar" /><strong>Ana Silva</strong></div>
    <button onClick={() => setVisible(v => !v)}>Alternar conversa</button>
    {visible && <div style={{display:'flex',flexDirection:'column',gap:20,marginTop:20}}>
      {(['audio','file','image','missing'] as const).map((id,i) => <article key={id} className={`message-bubble ${i % 2 ? 'is-outbound' : 'is-inbound'}`}>
        <div className="msg-bubble-body"><InboxMedia getToken={token} message={{ id, workspaceId:'fixture',conversationId:'fixture',type:id === 'missing' ? 'audio' : id,
          body:id === 'file' ? 'Cotacao-demonstracao.pdf' : id === 'image' ? 'Imagem recebida' : 'Áudio recebido', mediaUrl:id === 'audio' ? 'data:audio/ogg;base64,YQ==' : null,
          providerMessageId:null,sentByUserId:null,status:'delivered',direction:'inbound',createdAt:new Date().toISOString() }} /><time>16:09</time></div>
      </article>)}
    </div>}
  </main></ContactPhotoProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
