'use strict';

const path = require('node:path');
const { z } = require('zod');

const booleanFromEnv = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3002),
  DATA_DIR: z.string().min(1).default(path.join(process.cwd(), 'data')),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Comma separated list of allowed browser origins for WebSocket and CORS. Empty = same origin only. */
  ALLOWED_ORIGINS: z.string().default(''),
  /** When set, creating a board requires this value in the X-Admin-Token header. */
  BOARD_CREATION_TOKEN: z.string().min(16).optional(),
  /** Number of reverse proxies in front of the app (for client IPs in rate limiting). */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  RATE_LIMIT_WRITES_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  PERSIST_DEBOUNCE_MS: z.coerce.number().int().min(0).max(10_000).default(250),
  ENABLE_API_DOCS: booleanFromEnv.default(true),
});

/**
 * Parses and validates configuration. Throws with every problem listed, so a
 * misconfigured deployment fails at boot instead of at the first request.
 * @param {NodeJS.ProcessEnv} env
 */
function loadConfig(env = process.env) {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const config = result.data;
  return Object.freeze({
    ...config,
    allowedOrigins: config.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
}

module.exports = { loadConfig };
