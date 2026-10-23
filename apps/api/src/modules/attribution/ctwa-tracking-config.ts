import { z } from 'zod';
export const TRACKING_ENDPOINT = 'https://www.prymeiradigital.com.br/api/integrations/talk-ctwa';
const configSchema = z.object({
    endpoint: z.literal(TRACKING_ENDPOINT),
    signingKey: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean(),
    // An enabled manual bridge does not opt the workspace into automatic forwarding.
    autoForward: z.boolean().default(false),
    lifecycleEnabled: z.boolean().default(false),
    lifecycleEnabledAt: z.number().int().positive().max(8640000000000).optional()
}).strict().refine(config => !config.lifecycleEnabled || config.lifecycleEnabledAt !== undefined, { message: 'Lifecycle activation timestamp required' });
export type CtwaTrackingConfig = z.infer<typeof configSchema>;
function workspaceMap(secret: string | undefined): Record<string, unknown> | null {
    if (!secret || secret.length > 1048576)
        return null;
    try {
        const map: unknown = JSON.parse(secret);
        return map && typeof map === 'object' && !Array.isArray(map) ? map as Record<string, unknown> : null;
    }
    catch {
        return null;
    }
}
export function hasTrackingOwnership(secret: string | undefined, workspaceId: string) {
    const map = workspaceMap(secret);
    return !!map && Object.hasOwn(map, workspaceId);
}
export function resolveTrackingConfig(secret: string | undefined, workspaceId: string): CtwaTrackingConfig | null {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workspaceId))
        return null;
    const map = workspaceMap(secret);
    if (!map || !Object.hasOwn(map, workspaceId))
        return null;
    const parsed = configSchema.safeParse(map[workspaceId]);
    return parsed.success ? parsed.data : null;
}
export function automaticTrackingWorkspaces(secret: string | undefined): string[] {
    return Object.keys(workspaceMap(secret) || {}).filter(id => { const config = resolveTrackingConfig(secret, id); return config?.enabled && config.autoForward; });
}

export function resolveLifecycleConfig(secret: string | undefined, workspaceId: string) {
    const config = resolveTrackingConfig(secret, workspaceId);
    return config?.enabled && config.lifecycleEnabled && config.lifecycleEnabledAt !== undefined ? config as CtwaTrackingConfig & { lifecycleEnabledAt: number } : null;
}
export function lifecycleTrackingWorkspaces(secret: string | undefined): string[] {
    return Object.keys(workspaceMap(secret) || {}).filter(id => !!resolveLifecycleConfig(secret, id));
}
