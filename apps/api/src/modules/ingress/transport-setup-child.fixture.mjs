// Test-only worker launch: retain the production configuration guard while a
// disposable TCP proxy withholds real broker frames during this child's setup.
import amqp from 'amqplib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const connect = amqp.connect.bind(amqp);
amqp.connect = (_url, options) => connect(process.env.INGRESS_TEST_PROXY_URL, options);
await import(pathToFileURL(resolve('dist/ingress-worker.js')).href);
