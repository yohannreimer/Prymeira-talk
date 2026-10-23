import { expect, it } from 'vitest';
import { resolveTrackingConfig, TRACKING_ENDPOINT } from './ctwa-tracking-config.js';
const id='00000000-0000-4000-8000-000000000001';
const base={endpoint:TRACKING_ENDPOINT,signingKey:'a'.repeat(64),enabled:true};
it('existing lead config defaults lifecycle off; activated entries require epoch',()=>{
 expect(resolveTrackingConfig(JSON.stringify({[id]:base}),id)).toMatchObject({lifecycleEnabled:false});
 expect(resolveTrackingConfig(JSON.stringify({[id]:{...base,lifecycleEnabled:true,lifecycleEnabledAt:1792750000}}),id)).toMatchObject({lifecycleEnabled:true});
 expect(resolveTrackingConfig(JSON.stringify({[id]:{...base,lifecycleEnabled:true}}),id)).toBeNull();
});
