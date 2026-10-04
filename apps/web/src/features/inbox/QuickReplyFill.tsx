import { useEffect, useRef, useState } from 'react';
import { Sparkles, UserRound, Building2, X } from 'lucide-react';
import type { TemplateFieldKey } from './quick-reply-template';

/** What the seller can type for the missing fields: the contact's name (first or full) and their company. */
export type FillAnswer = { name?: string; company?: string };

export function missingLabel(missing: TemplateFieldKey[]) {
  const name = missing.includes('primeiro_nome') || missing.includes('nome');
  const company = missing.includes('empresa');
  return name && company ? 'o nome e a empresa' : name ? 'o nome' : 'a empresa';
}
export function withoutLabel(missing: TemplateFieldKey[]) {
  const name = missing.includes('primeiro_nome') || missing.includes('nome');
  const company = missing.includes('empresa');
  return name && company ? 'Sem esses dados' : name ? 'Sem nome' : 'Sem empresa';
}

/**
 * A quick reply needs something Talk does not know about this contact. Rather than a sentence with a hole, the seller
 * types it (saved on the contact for next time) or sends without it: the AI rewrites the message once and keeps it.
 */
export function QuickReplyFill({ title, missing, contactLabel, busy, error, onUse, onWithout, onCancel }: {
  title: string;
  missing: TemplateFieldKey[];
  contactLabel: string;
  busy: 'use' | 'without' | null;
  error: string | null;
  onUse(answer: FillAnswer): void;
  onWithout(): void;
  onCancel(): void;
}) {
  const askName = missing.includes('primeiro_nome') || missing.includes('nome');
  const askCompany = missing.includes('empresa');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const ready = (!askName || name.trim()) && (!askCompany || company.trim());
  const use = () => { if (ready && !busy) onUse({ ...(askName ? { name: name.trim() } : {}), ...(askCompany ? { company: company.trim() } : {}) }); };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); use(); }
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
  };
  return <div className="slash-menu qr-fill" role="dialog" aria-label={`Completar ${title}`} onKeyDown={keys}>
    <header><strong>{title}</strong><span>Falta {missingLabel(missing)} {contactLabel}</span>
      <button type="button" className="qr-fill-close" aria-label="Cancelar" onClick={onCancel}><X size={15} /></button></header>
    <div className="qr-fill-body">
      {askName ? <label><UserRound size={15} aria-hidden="true" /><input ref={first} value={name} disabled={Boolean(busy)} maxLength={60}
        placeholder="Como chamar o cliente (ex.: Cristiano)" onChange={event => setName(event.target.value)} /></label> : null}
      {askCompany ? <label><Building2 size={15} aria-hidden="true" /><input ref={askName ? undefined : first} value={company} disabled={Boolean(busy)} maxLength={120}
        placeholder="Empresa do cliente" onChange={event => setCompany(event.target.value)} /></label> : null}
      <div className="qr-fill-actions">
        <button type="button" className="qr-fill-use" disabled={!ready || Boolean(busy)} onClick={use}>{busy === 'use' ? 'Salvando…' : 'Usar e salvar no contato'}</button>
        <span>ou</span>
        <button type="button" className="qr-fill-without" disabled={Boolean(busy)} onClick={onWithout}>
          <Sparkles size={14} aria-hidden="true" className={busy === 'without' ? 'is-spinning' : undefined} />{busy === 'without' ? 'Ajustando a frase…' : withoutLabel(missing)}</button>
      </div>
      <small>{withoutLabel(missing)}: a IA ajusta a frase uma vez e guarda para as próximas.</small>
      {error ? <p className="qr-fill-error" role="alert">{error}</p> : null}
    </div>
  </div>;
}
