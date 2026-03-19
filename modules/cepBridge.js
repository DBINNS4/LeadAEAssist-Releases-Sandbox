// === Unified CEP bridge: delegate to secure loopback server ===
// This shim keeps the old global.cepBridge contract (on/off/emit) but
// routes everything through the static loopback WebSocket server.

const { EventEmitter } = require('events');
const {
  startServer,
  getCredentials,
  broadcast,
  onMessage
} = require('../services/bridgeServerService');

// Single shared event bus for CEP → backend messages
const bridgeEvents = new EventEmitter();
let wiredMessageForwarder = false;

function ensureMessageForwarding() {
  if (wiredMessageForwarder) return;
  wiredMessageForwarder = true;

  if (typeof onMessage === 'function') {
    onMessage(msg => {
      if (!msg || typeof msg !== 'object') return;
      const type = msg.type;
      if (!type) return;
      try {
        // Primary event: by type (e.g. 'queue-job-progress')
        bridgeEvents.emit(type, msg);
        // Wildcard for any generic listeners
        bridgeEvents.emit('*', msg);
      } catch {
        // Never crash the bridge on handler errors
      }
    });
  }
}

async function startCEPBridge(opts = {}) {
  void opts; // opts preserved for backward compatibility hooks
  void getCredentials; // keep import for legacy callers without lint noise

  // Start or reuse secure loopback server (HTTP + WS + token)
  const result = await startServer();
  if (result && result.ok === false) {
    const err = new Error(result.error || 'Bridge server unavailable.');
    err.code = result.code || 'BRIDGE_NOT_READY';
    err.port = result.port || 32123;
    throw err;
  }

  const { port, token, expiresAt } = result;
  ensureMessageForwarding();

  const api = {
    port,
    token,
    expiresAt,
    broadcast, // send JSON-serializable messages to CEP panel
    on: (...args) => bridgeEvents.on(...args),
    once: (...args) => bridgeEvents.once(...args),
    off: (...args) =>
      typeof bridgeEvents.off === 'function'
        ? bridgeEvents.off(...args)
        : bridgeEvents.removeListener(...args),
    removeListener: (...args) => bridgeEvents.removeListener(...args),
    emit: (...args) => bridgeEvents.emit(...args)
  };

  // Preserve legacy global handle
  global.cepBridge = api;
  return api;
}

module.exports = { startCEPBridge };
