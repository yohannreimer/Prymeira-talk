import { z } from 'zod';

export const messageLocationSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  name: z.string().max(200).nullable(),
  address: z.string().max(1000).nullable(),
  isLive: z.boolean()
});
export type MessageLocation = z.infer<typeof messageLocationSchema>;

export function locationMapUrl(location: MessageLocation): string | null {
  const parsed = messageLocationSchema.safeParse(location);
  if (!parsed.success) return null;
  const { latitude, longitude, name, address } = parsed.data;
  const query = latitude !== null && longitude !== null
    ? `${latitude},${longitude}` : [name, address].filter(Boolean).join(', ').trim();
  return query ? `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query })}` : null;
}
