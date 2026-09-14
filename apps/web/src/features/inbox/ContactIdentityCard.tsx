import { useRef, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import { ContactAvatar } from './ContactAvatar';
import './contact-identity.css';

export function contactNameError(name: string) {
  if (!name.trim()) return 'Digite o nome do contato.';
  return name.trim().length > 200 ? 'Use até 200 caracteres.' : null;
}

/** Key by contactId in the inbox so an unfinished edit never follows another contact. */
export function ContactIdentityCard({ contactId, conversationId, name, phone, channelName, onSave }: {
  conversationId?: string;
  contactId: string; name: string | null; phone: string | null; channelName?: string | null;
  onSave: (contactId: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const displayName = name?.trim() || null;

  function close() {
    if (busy.current) return;
    setEditing(false); setError(null);
    requestAnimationFrame(() => editButton.current?.focus());
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const invalid = contactNameError(value);
    if (invalid) { setError(invalid); return; }
    busy.current = true; setSaving(true); setError(null);
    try {
      await onSave(contactId, value.trim());
      setEditing(false); setSaved(true);
      requestAnimationFrame(() => editButton.current?.focus());
    } catch {
      setError('Não foi possível salvar. Seu texto foi mantido; tente novamente.');
    } finally { busy.current = false; setSaving(false); }
  }

  return <div className="context-card contact-identity-card">
    <div className="contact-identity-heading">
      <ContactAvatar conversationId={conversationId} name={name} className="context-identity-avatar" />
      <div className="contact-identity-details">
        <div className="context-identity-name">{displayName || 'Contato sem nome'}</div>
        {phone ? <div className="contact-identity-phone">{phone}</div> : null}
        {channelName ? <div className="context-identity-sub">{channelName}</div> : null}
      </div>
    </div>
    {editing ? <form className="contact-name-form" onSubmit={save} aria-busy={saving}>
      <label htmlFor="inbox-contact-name">Nome do contato</label>
      <input id="inbox-contact-name" value={value} maxLength={200} autoFocus autoComplete="off" disabled={saving}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'inbox-contact-name-error' : undefined}
        onChange={event => { setValue(event.target.value); setError(null); }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }} />
      {error ? <p id="inbox-contact-name-error" role="alert">{error}</p> : null}
      <div className="contact-name-actions">
        <button className="contact-name-save" type="submit" disabled={saving}>{saving ? 'Salvando…' : 'Salvar nome'}</button>
        <button type="button" onClick={close} disabled={saving}>Cancelar</button>
      </div>
    </form> : <div className="contact-name-footer">
      <button ref={editButton} className="contact-name-edit" type="button" onClick={() => {
        setValue(displayName ?? ''); setError(null); setSaved(false); setEditing(true);
      }}><Pencil size={13} aria-hidden="true" />{displayName ? 'Editar nome' : 'Adicionar nome'}</button>
      {saved ? <span role="status">Nome salvo</span> : null}
    </div>}
  </div>;
}
