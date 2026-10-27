'use strict';

const pino = require('pino');

/**
 * Structured JSON logger. Authorization headers and tokens are redacted so
 * board secrets never end up in log storage.
 * @param {{ LOG_LEVEL: string }} config
 */
function createLogger(config) {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'collab-kanban' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-admin-token"]', 'token', '*.token'],
      censor: '[redacted]',
    },
  });
}

module.exports = { createLogger };
