import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validCtwa } from '../waha/waha-ctwa.js';

export type ConversionName = 'LeadSubmitted' | 'QualifiedLead' | 'Purchase';
export const purchaseSchema = z.object({
  orderId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  // Matches persisted DECIMAL precision without silently rounding the business fact.
  value: z.number().finite().min(0.0001).max(1000000000000)
    .refine(value => Number(value.toFixed(4)) === value),
  currency: z.string().regex(/^[A-Z]{3}$/)
}).strict();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function stableCtwaEventId(
  workspaceId: string, channelId: string, attributionId: string,
  name: ConversionName, businessKey = 'once'
) {
  return `ctwa_${hash(JSON.stringify([workspaceId, channelId, attributionId, name, businessKey]))}`;
}

export const configSchema = z.object({
  datasetId: z.string().regex(/^\d{1,64}$/),
  whatsappBusinessAccountId: z.string().regex(/^\d{1,64}$/),
  pageId: z.string().regex(/^\d{1,64}$/).optional(),
  accessToken: z.string().min(1).max(8192),
  enabled: z.boolean().default(false),
  testEventCode: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()
}).strict();
export type CtwaConfig = z.infer<typeof configSchema>;

/** The secret is a JSON map keyed by exact authenticated workspace ID; never a process-wide fallback token. */
export function resolveCtwaConfig(secret: string | undefined, workspaceId: string): CtwaConfig | null {
  if (!secret || secret.length > 1048576) return null;
  try {
    const map: unknown = JSON.parse(secret);
    if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.hasOwn(map, workspaceId)) return null;
    const result = configSchema.safeParse((map as Record<string, unknown>)[workspaceId]);
    return result.success && result.data.enabled ? result.data : null;
  } catch {
    return null;
  }
}

export function buildCtwaPayload(input: {
  workspaceId: string; channelId: string; attributionId: string;
  ctwaClid: string; name: ConversionName; eventTime: Date;
  orderId?: string; value?: number; currency?: string;
}, config: Pick<CtwaConfig, 'whatsappBusinessAccountId' | 'pageId' | 'testEventCode'>) {
  if (!validCtwa({ ctwaClid: input.ctwaClid }) || !Number.isFinite(input.eventTime.getTime())
    || input.eventTime.getTime() < 0 || !['LeadSubmitted', 'QualifiedLead', 'Purchase'].includes(input.name)) {
    throw new Error('Invalid conversion');
  }
  const purchase = input.name === 'Purchase'
    ? purchaseSchema.parse({ orderId: input.orderId, value: input.value, currency: input.currency })
    : undefined;
  return {
    data: [{
      event_name: input.name,
      event_time: Math.floor(input.eventTime.getTime() / 1000),
      event_id: stableCtwaEventId(input.workspaceId, input.channelId, input.attributionId,
        input.name, purchase ? hash(purchase.orderId) : 'once'),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: {
        ctwa_clid: input.ctwaClid,
        whatsapp_business_account_id: config.whatsappBusinessAccountId,
        ...(config.pageId ? { page_id: config.pageId } : {})
      },
      ...(purchase ? {
        custom_data: { order_id: purchase.orderId, value: purchase.value, currency: purchase.currency }
      } : {})
    }],
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {})
  };
}
