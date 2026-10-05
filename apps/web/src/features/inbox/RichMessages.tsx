import { useState } from 'react';
import { BarChart3, Check, Copy } from 'lucide-react';
import type { PollTally } from './message-threading';
import './rich-messages.css';

/** A WhatsApp poll like WhatsApp draws it: the question, then each option with its votes and a bar. */
export function PollMessage({ poll, tally }: { poll: { title: string; options: string[] }; tally?: PollTally }) {
  const most = Math.max(1, ...poll.options.map(option => tally?.options.get(option)?.count ?? 0));
  const voters = tally?.voters ?? 0;
  return <div className="poll-message">
    <strong className="poll-message-title"><BarChart3 size={15} aria-hidden="true" />{poll.title || 'Enquete'}</strong>
    <ul>
      {poll.options.map(option => {
        const entry = tally?.options.get(option);
        return <li key={option} className={entry?.mine ? 'is-mine' : undefined}>
          <span className="poll-message-option"><span className="poll-message-dot" aria-hidden="true">{entry?.mine ? <Check size={11} strokeWidth={3} /> : null}</span>{option}
            <small>{entry?.count ?? 0}</small></span>
          <span className="poll-message-bar" aria-hidden="true"><span style={{ width: `${((entry?.count ?? 0) / most) * 100}%` }} /></span>
        </li>;
      })}
    </ul>
    <small className="poll-message-total">{voters === 0 ? 'Nenhum voto ainda' : voters === 1 ? '1 pessoa votou' : `${voters} pessoas votaram`}</small>
  </div>;
}

/** The "Copiar chave Pix" button WhatsApp draws under a shared Pix key. */
export function PixKeyAction({ pixKey }: { pixKey: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(pixKey).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }).catch(() => undefined);
  };
  return <button type="button" className="pix-key-action" onClick={copy}>
    {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? 'Chave copiada' : 'Copiar chave Pix'}
  </button>;
}
