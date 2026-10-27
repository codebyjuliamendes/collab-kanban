'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { Database } = require('./db/database');
const { createBoardService } = require('./domain/board-service');
const { createApp } = require('./http/app');
const { createHub } = require('./ws/hub');

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_DB_PATH = path.join(__dirname, '..', 'kanban.db');

/** The first version stored `kanban.db` next to the code; adopt it once. */
function adoptLegacyDatabase(dataDir, logger) {
  const target = path.join(dataDir, 'kanban.db');
  if (fs.existsSync(target) || !fs.existsSync(LEGACY_DB_PATH)) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(LEGACY_DB_PATH, target);
  logger.warn({ from: LEGACY_DB_PATH, to: target }, 'copied legacy database into DATA_DIR');
}

/**
 * Wires everything together and starts listening.
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string|null, logger?: import('pino').Logger }} [options]
 * `dataDir: null` keeps the database in memory (tests).
 */
async function startServer(options = {}) {
  const config = loadConfig(options.env ?? process.env);
  const logger = options.logger ?? createLogger(config);
  const dataDir = options.dataDir === undefined ? config.DATA_DIR : options.dataDir;
  if (dataDir) adoptLegacyDatabase(dataDir, logger);
  const db = await Database.open({
    dataDir,
    debounceMs: config.PERSIST_DEBOUNCE_MS,
    logger,
  });
  const service = createBoardService({ db });
  service.pruneAppliedOps();

  let ready = false;
  let hub = null; // created after the HTTP server, used lazily by the app
  const app = createApp({
    service,
    config,
    logger,
    publish: (boardId, events) => hub.publish(boardId, events),
    onTokensRevoked: (boardId, role, exceptTokenId) => hub.disconnectRevoked(boardId, role, exceptTokenId),
    isReady: () => ready && db.isHealthy(),
  });
  const server = http.createServer(app);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  hub = createHub({ server, service, config, logger });

  const pruneTimer = setInterval(() => {
    try {
      service.pruneAppliedOps();
    } catch (err) {
      logger.error({ err }, 'failed to prune idempotency log');
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.PORT, config.HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  ready = true;
  const { port } = server.address();
  logger.info({ port, host: config.HOST, env: config.NODE_ENV }, 'server listening');

  let stopping = null;
  /** Stops accepting work, closes sockets and flushes the database. */
  function stop() {
    if (stopping) return stopping;
    ready = false;
    clearInterval(pruneTimer);
    stopping = (async () => {
      await hub.close();
      await new Promise((resolve) => server.close(() => resolve()));
      db.close();
      logger.info('server stopped');
    })();
    return stopping;
  }

  return { port, server, stop, service, config, logger };
}

/** Process entry point: starts the server and handles signals. */
function runMain() {
  return startServer()
    .then(({ stop, logger }) => {
      const shutdown = (signal) => {
        logger.info({ signal }, 'shutting down');
        const force = setTimeout(() => {
          logger.error('forced exit after shutdown timeout');
          process.exit(1);
        }, 10_000);
        force.unref();
        stop().then(
          () => process.exit(0),
          (err) => {
            logger.error({ err }, 'error during shutdown');
            process.exit(1);
          },
        );
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
    })
    .catch((err) => {
      // The logger may not exist yet (invalid config), so fall back to stderr.
      console.error(JSON.stringify({ level: 'fatal', msg: 'failed to start', error: err.message }));
      process.exit(1);
    });
}

module.exports = { startServer, runMain };

if (require.main === module) runMain();
