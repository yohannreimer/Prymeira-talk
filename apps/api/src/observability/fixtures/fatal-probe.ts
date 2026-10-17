// Disposable child-process probe. The SDK transport is entirely in memory.
import * as Sentry from '@sentry/node';
import { privateEvent } from '../glitchtip.js';

const finish = () => { void Sentry.flush(1000).then(() => process.exit(0)); };
Sentry.initWithoutDefaultIntegrations({
  dsn: 'https://test@example.invalid/1', defaultIntegrations: false,
  integrations: [Sentry.onUnhandledRejectionIntegration({ mode: 'none' }), Sentry.onUncaughtExceptionIntegration({ onFatalError: finish })],
  enableRuntimeChannelInjection: false, includeServerName: false, sendClientReports: false,
  beforeSend: privateEvent,
  transport: () => ({ send: async envelope => { process.stdout.write(JSON.stringify(envelope) + '\n'); finish(); return { statusCode: 200 }; }, flush: async () => true }),
});
const error = new TypeError("ownKeys trap did not include '$on' PRIVATE_FATAL_FIXTURE");
error.stack = 'TypeError: PRIVATE_FATAL_FIXTURE\n at hiddenFunction (/private/operator/apps/api/src/modules/agents/agent-runtime.ts:1539:27)';
setTimeout(() => {
  if (process.argv[2] === 'rejection') void Promise.reject(error);
  else throw error;
}, 0);
setTimeout(() => process.exit(2), 3000).unref();
