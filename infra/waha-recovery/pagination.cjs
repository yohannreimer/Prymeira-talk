'use strict';
// The provider filters protocol/reaction rows AFTER SQL pagination. Recovery needs
// the raw row count, not the number of visible messages, to prove exhaustion.
const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const { createHash } = require('node:crypto');
const context = new AsyncLocalStorage();
const HEADER = 'x-talk-recovery-pagination';
function install(Session, parseJsonList) {
  const original = Session.prototype.getChatMessages;
  if (typeof original !== 'function') throw new Error('Unsupported WAHA recovery adapter');
  Session.prototype.getChatMessages = async function (chatId, query, filter) {
    const current = context.getStore();
    if (!current || current.request.headers[HEADER] !== '1') return original.call(this, chatId, query, filter);
    if (chatId !== 'all' || !Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100
      || !Number.isSafeInteger(filter['filter.timestamp.gte']) || !Number.isSafeInteger(filter['filter.timestamp.lte'])
      || filter['filter.timestamp.gte'] > filter['filter.timestamp.lte']) throw new Error('Invalid recovery pagination request');
    let count, rawDigest;
    const scoped = Object.create(this);
    scoped.client = new Proxy(this.client, { get(target, key) {
      if (key !== 'GetMessages') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
      return (request, callback) => target.GetMessages(request, (error, response) => {
        if (!error) {
          try { const rows = parseJsonList(response); if (!Array.isArray(rows) || rows.length > query.limit) throw new Error('Invalid provider page'); count = rows.length; rawDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
          catch (failure) { callback(failure); return; }
        }
        callback(error, response);
      });
    } });
    const messages = await original.call(scoped, chatId, query, filter);
    if (!Number.isSafeInteger(count)) throw new Error('Missing raw recovery pagination');
    current.response.setHeader(HEADER, '1');
    current.response.setHeader('x-talk-recovery-raw-count', String(count));
    current.response.setHeader('x-talk-recovery-raw-digest', rawDigest);
    current.response.setHeader('x-talk-recovery-next-offset', String(query.offset + count));
    current.response.setHeader('x-talk-recovery-exhausted', count === 0 ? 'true' : 'false');
    return messages;
  };
}
function installHttp() {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event !== 'request') return emit.call(this, event, ...args);
    const [request, response] = args;
    return context.run({ request, response }, () => emit.call(this, event, ...args));
  };
}
module.exports = { install, installHttp, context };
if (process.env.TALK_WAHA_RECOVERY_METADATA === 'true') {
  // Pinned WAHA 2026.9.1 modules. Refuse startup if the expected contract is absent.
  const { WhatsappSessionGoWSCore } = require('/app/dist/core/engines/gows/session.gows.core');
  const { parseJsonList } = require('/app/dist/core/engines/gows/helpers');
  install(WhatsappSessionGoWSCore, parseJsonList);
  installHttp();
}
