'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { AppError, badRequest, unauthorized, notFound } = require('../errors');
const { batchSchema, boardTitleSchema } = require('../domain/ops');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', '..', 'shared');
const SWAGGER_DIR = path.dirname(require.resolve('swagger-ui-dist/package.json'));

const roleSchema = z.object({ role: z.enum(['editor', 'viewer']) });
const createBoardSchema = z.object({ title: boardTitleSchema });
const opsBodySchema = z.object({ ops: batchSchema });

function parseBody(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw badRequest(
      'Invalid request body',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

const asyncRoute = (handler) => (req, res, next) => {
  try {
    handler(req, res, next);
  } catch (err) {
    next(err);
  }
};

/**
 * Builds the Express application. Side effects (broadcasting, readiness) are
 * injected so the HTTP layer can be tested without a running server.
 *
 * @param {{
 *   service: ReturnType<import('../domain/board-service').createBoardService>,
 *   config: ReturnType<import('../config').loadConfig>,
 *   logger: import('pino').Logger,
 *   publish: (boardId: string, events: object[]) => void,
 *   onTokensRevoked?: (boardId: string, role: string, exceptTokenId: string) => void,
 *   isReady: () => boolean,
 * }} deps
 */
function createApp({ service, config, logger, publish, onTokensRevoked = () => {}, isReady }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      logger[level]({ method: req.method, path: req.path, status: res.statusCode, durationMs }, 'request');
    });
    next();
  });

  const connectSrc = ["'self'", ...config.allowedOrigins];
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc,
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.NODE_ENV === 'production',
    }),
  );
  app.use(compression());

  // CORS: same origin by default; extra origins only when configured.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // --- health -------------------------------------------------------------
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (req, res) => {
    const ready = isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });

  // --- API ----------------------------------------------------------------
  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.RATE_LIMIT_WRITES_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } }),
  });
  const createBoardLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many boards created' } }),
  });

  const authorize = (req, res, next) => {
    try {
      req.access = service.authorize(req.params.boardId, bearerToken(req));
      next();
    } catch (err) {
      next(err);
    }
  };

  api.post(
    '/boards',
    createBoardLimiter,
    asyncRoute((req, res) => {
      if (config.BOARD_CREATION_TOKEN && req.get('x-admin-token') !== config.BOARD_CREATION_TOKEN) {
        throw unauthorized('Board creation requires a valid X-Admin-Token header');
      }
      const { title } = parseBody(createBoardSchema, req.body);
      res.status(201).json(service.createBoard(title));
    }),
  );

  api.get(
    '/boards/:boardId',
    authorize,
    asyncRoute((req, res) => {
      res.json({ ...service.getSnapshot(req.params.boardId), role: req.access.role });
    }),
  );

  api.post(
    '/boards/:boardId/ops',
    writeLimiter,
    authorize,
    asyncRoute((req, res) => {
      const { ops } = parseBody(opsBodySchema, req.body);
      const { results, events } = service.applyOps(req.params.boardId, ops, req.access);
      if (events.length > 0) publish(req.params.boardId, events);
      res.json({ results });
    }),
  );

  api.post(
    '/boards/:boardId/invites',
    writeLimiter,
    authorize,
    asyncRoute((req, res) => {
      const { role } = parseBody(roleSchema, req.body);
      res.status(201).json({ role, token: service.issueToken(req.params.boardId, req.access, role) });
    }),
  );

  api.post(
    '/boards/:boardId/invites/revoke',
    writeLimiter,
    authorize,
    asyncRoute((req, res) => {
      const { role } = parseBody(roleSchema, req.body);
      const revoked = service.revokeTokens(req.params.boardId, req.access, role);
      onTokensRevoked(req.params.boardId, role, req.access.tokenId);
      res.json({ role, revoked });
    }),
  );

  api.use(() => {
    throw notFound('Route not found');
  });
  app.use('/api', api);

  // --- API docs (Swagger UI, self-hosted) ----------------------------------
  if (config.ENABLE_API_DOCS) {
    const docsCsp = helmet.contentSecurityPolicy({
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    });
    // express.static redirects /api-docs to /api-docs/ by itself.
    app.use('/api-docs', docsCsp, express.static(path.join(PUBLIC_DIR, 'api-docs')));
    app.use('/api-docs/vendor', docsCsp, express.static(SWAGGER_DIR, { index: false }));
  }

  // --- static frontend ----------------------------------------------------
  const staticOptions = {
    index: 'index.html',
    setHeaders(res) {
      // File names are not content-hashed, so always revalidate (cheap with ETags).
      res.set('Cache-Control', 'no-cache');
    },
  };
  app.use('/shared', express.static(SHARED_DIR, staticOptions));
  app.use(express.static(PUBLIC_DIR, staticOptions));

  // --- errors -------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    }
    logger.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}

module.exports = { createApp };
