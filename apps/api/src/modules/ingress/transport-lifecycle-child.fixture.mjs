// Test-only launch wrapper. Silence only this disposable worker's real sockets,
// after both actual AMQP consumers have completed registration.
import amqp from 'amqplib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const connect = amqp.connect.bind(amqp), models = [];
let registrations = 0;
amqp.connect = async (...args) => {
  const model = await connect(...args); models.push(model);
  const createChannel = model.createChannel.bind(model);
  model.createChannel = async (...channelArgs) => {
    const channel = await createChannel(...channelArgs), consume = channel.consume.bind(channel);
    channel.consume = async (...consumeArgs) => {
      const result = await consume(...consumeArgs);
      if (++registrations === 2) process.send?.({ ready: true });
      return result;
    };
    return channel;
  };
  return model;
};
process.on('message', message => {
  if (message !== 'silence') return;
  for (const model of models) model.connection.stream.removeAllListeners('readable');
  process.send?.({ silenced: models.length });
  process.channel?.unref();
});
await import(pathToFileURL(resolve('dist/ingress-worker.js')).href);
