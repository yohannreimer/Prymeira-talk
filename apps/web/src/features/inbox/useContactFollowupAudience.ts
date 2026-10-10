import { useCallback, useEffect, useState } from 'react';
import { apiGetContactFollowupAudience, apiSetContactFollowupAudience, type ContactFollowupAudience } from '../../app/api';

/** Whether the follow-up AI treats this contact as a customer, and the seller's "É cliente" correction. */
export function useContactFollowupAudience(contactId: string | null, getToken: () => Promise<string | null>) {
  const [snapshot, setSnapshot] = useState<{ contactId: string; audience: ContactFollowupAudience } | null>(null);
  useEffect(() => {
    if (!contactId) return;
    let active = true;
    void apiGetContactFollowupAudience(getToken, contactId)
      .then(audience => { if (active) setSnapshot({ contactId, audience }); })
      // A side note on the contact: when it cannot load, nothing is shown.
      .catch(() => undefined);
    return () => { active = false; };
  }, [contactId, getToken]);
  const markCustomer = useCallback(async () => {
    if (!contactId) return;
    const audience = await apiSetContactFollowupAudience(getToken, contactId, 'customer');
    setSnapshot({ contactId, audience });
  }, [contactId, getToken]);
  return { audience: snapshot && snapshot.contactId === contactId ? snapshot.audience : null, markCustomer };
}
