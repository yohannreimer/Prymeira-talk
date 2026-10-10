// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGetContactFollowupAudience, apiSetContactFollowupAudience } from '../../app/api';
import { ContactIdentityCard } from './ContactIdentityCard';
import { useContactFollowupAudience } from './useContactFollowupAudience';

vi.mock('../../app/api', () => ({ apiGetContactFollowupAudience: vi.fn(), apiSetContactFollowupAudience: vi.fn() }));
const token = async () => 'token';
function Probe({ contactId }: { contactId: string }) {
  const { audience, markCustomer } = useContactFollowupAudience(contactId, token);
  return <ContactIdentityCard contactId={contactId} name="Marcos" phone={null} onSave={vi.fn()} followupAudience={audience} onMarkCustomer={markCustomer} />;
}
afterEach(() => { vi.clearAllMocks(); });

describe('contact follow-up audience', () => {
  it('"É cliente" tells the AI to treat the contact as a customer and hides the note', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiGetContactFollowupAudience).mockResolvedValue({ kind: 'internal_personal', source: 'ai' });
    vi.mocked(apiSetContactFollowupAudience).mockResolvedValue({ kind: 'customer', source: 'manual' });
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<Probe contactId="contact-1" />));
      expect(container.textContent).toContain('A IA trata este contato como interno ou pessoal');
      const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'É cliente');
      await act(async () => button?.click());
      expect(apiSetContactFollowupAudience).toHaveBeenCalledWith(token, 'contact-1', 'customer');
      expect(container.textContent).not.toContain('A IA trata este contato');
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
