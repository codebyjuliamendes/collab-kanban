'use strict';

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { z } = require('zod');
const { AppError } = require('../errors');

const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const PRESENCE_COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#0ea5e9', '#22c55e'];

const CLOSE = Object.freeze({
  shuttingDown: 1001,
  unauthorized: 4001,
  helloTimeout: 4002,
  protocolError: 4003,
  revoked: 4004,
});

const nameSchema = z
  .string()
  .transform((value) => value.replace(/[\u0000-\u001F\u007F]/g, '').trim()) // eslint-disable-line no-control-regex
  .pipe(z.string().min(1).max(40));

const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    boardId: z.string().max(64),
    token: z.string().max(128),
    name: z.string().optional(),
  }),
  z.object({ type: z.literal('ops'), requestId: z.string().max(64), ops: z.array(z.unknown()).min(1).max(100) }),
  z.object({ type: z.literal('presence'), name: z.string() }),
  z.object({ type: z.literal('resync') }),
  z.object({ type: z.literal('ping') }),
]);

/** Simple token bucket: `capacity` burst, refilled at `perSecond`. */
function createBucket(capacity, perSecond) {
  let tokens = capacity;
  let last = Date.now();
  return (cost = 1) => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };
}

/**
 * Real-time hub. Clients join one board after authenticating with a `hello`
 * message (the token never travels in the URL, so it stays out of access
 * logs). Every applied operation is fanned out as an `event` with the
 * board's sequence number; clients that notice a gap ask for a `resync`.
 */
function createHub({ server, service, config, logger }) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: ({ req }, done) => {
      const origin = req.headers.origin;
      if (!origin) return done(true); // non-browser clients
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        sameHost = false;
      }
      if (sameHost || config.allowedOrigins.includes(origin)) return done(true);
      logger.warn({ origin }, 'websocket origin rejected');
      return done(false, 403, 'Origin not allowed');
    },
  });

  /** @type {Map<string, Set<WebSocket>>} */
  const rooms = new Map();

  const send = (ws, message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  function presenceOf(boardId) {
    return [...(rooms.get(boardId) || [])].map((ws) => ({
      id: ws.session.connectionId,
      name: ws.session.name,
      color: ws.session.color,
      role: ws.session.role,
    }));
  }

  function broadcastPresence(boardId) {
    const users = presenceOf(boardId);
    for (const ws of rooms.get(boardId) || []) send(ws, { type: 'presence', users });
  }

  function publish(boardId, events) {
    for (const ws of rooms.get(boardId) || []) {
      for (const event of events) send(ws, { ...event, type: 'event' });
    }
  }

  function leave(ws) {
    const boardId = ws.session?.boardId;
    if (!boardId) return;
    const room = rooms.get(boardId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(boardId);
    else broadcastPresence(boardId);
  }

  function disconnectRevoked(boardId, role, exceptTokenId) {
    for (const ws of rooms.get(boardId) || []) {
      if (ws.session.role === role && ws.session.tokenId !== exceptTokenId) {
        ws.close(CLOSE.revoked, 'Token revoked');
      }
    }
  }

  function handleHello(ws, message) {
    let access;
    try {
      access = service.authorize(message.boardId, message.token);
    } catch (err) {
      if (err instanceof AppError) return ws.close(CLOSE.unauthorized, 'Unauthorized');
      throw err;
    }
    clearTimeout(ws.helloTimer);
    const name = nameSchema.safeParse(message.name ?? '');
    const colorIndex = crypto.createHash('sha1').update(ws.session.connectionId).digest()[0] % PRESENCE_COLORS.length;
    Object.assign(ws.session, {
      boardId: message.boardId,
      role: access.role,
      tokenId: access.tokenId,
      name: name.success ? name.data : 'Guest',
      color: PRESENCE_COLORS[colorIndex],
    });
    if (!rooms.has(message.boardId)) rooms.set(message.boardId, new Set());
    rooms.get(message.boardId).add(ws);
    send(ws, {
      type: 'welcome',
      connectionId: ws.session.connectionId,
      role: access.role,
      snapshot: service.getSnapshot(message.boardId),
    });
    broadcastPresence(message.boardId);
  }

  function handleMessage(ws, raw) {
    let parsed;
    try {
      parsed = messageSchema.safeParse(JSON.parse(raw.toString('utf8')));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      return send(ws, { type: 'error', code: 'bad_message', message: 'Malformed message' });
    }
    const message = parsed.data;

    if (message.type === 'ping') return send(ws, { type: 'pong' });
    if (message.type === 'hello') {
      if (ws.session.boardId) return send(ws, { type: 'error', code: 'already_joined', message: 'Already joined' });
      return handleHello(ws, message);
    }
    if (!ws.session.boardId) return ws.close(CLOSE.protocolError, 'Send hello first');

    const { boardId } = ws.session;
    if (message.type === 'resync') {
      if (!ws.session.allow(5)) return send(ws, { type: 'error', code: 'rate_limited', message: 'Slow down' });
      return send(ws, { type: 'snapshot', snapshot: service.getSnapshot(boardId) });
    }
    if (message.type === 'presence') {
      const name = nameSchema.safeParse(message.name);
      if (name.success && ws.session.allow(1)) {
        ws.session.name = name.data;
        broadcastPresence(boardId);
      }
      return undefined;
    }
    if (message.type === 'ops') {
      if (!ws.session.allow(message.ops.length)) {
        return send(ws, { type: 'ack', requestId: message.requestId, error: 'rate_limited', retryAfterMs: 2000 });
      }
      try {
        const { results, events } = service.applyOps(boardId, message.ops, ws.session);
        if (events.length > 0) publish(boardId, events); // events reach the sender before its ack
        return send(ws, { type: 'ack', requestId: message.requestId, results });
      } catch (err) {
        if (err instanceof AppError) {
          return send(ws, { type: 'ack', requestId: message.requestId, error: err.code, message: err.message });
        }
        throw err;
      }
    }
    return undefined;
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.session = {
      connectionId: crypto.randomUUID(),
      boardId: null,
      allow: createBucket(60, 20),
    };
    ws.helloTimer = setTimeout(() => ws.close(CLOSE.helloTimeout, 'Hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      try {
        handleMessage(ws, raw);
      } catch (err) {
        logger.error({ err }, 'websocket message failed');
        send(ws, { type: 'error', code: 'internal_error', message: 'Internal server error' });
      }
    });
    ws.on('close', () => {
      clearTimeout(ws.helloTimer);
      leave(ws);
    });
    ws.on('error', (err) => logger.warn({ err: err.message }, 'websocket error'));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(CLOSE.shuttingDown, 'Server shutting down');
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  const connectionCount = () => wss.clients.size;

  return { publish, disconnectRevoked, close, connectionCount };
}

module.exports = { createHub, CLOSE };
