import { applyEvent, confirmedFromSnapshot, emptyConfirmed } from './state.js';
import { boardCache } from './storage.js';

/** Random id usable as card/column/op id (works outside secure contexts too). */
export function uid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_REVOKED = 4004;
const PING_EVERY_MS = 25_000;
const SILENCE_LIMIT_MS = 65_000;
const MAX_BATCH = 100;
/** Stay well below the server's 256 KiB WebSocket message limit. */
const MAX_BATCH_BYTES = 128 * 1024;
const encoder = new TextEncoder();

/**
 * Real-time session for one board.
 *
 * Reliability rules:
 * - Local operations are stored (localStorage) until the server acknowledges
 *   them, so nothing is lost on reload, disconnect or offline use.
 * - Every operation has an `opId`; resending after a reconnect is safe.
 * - Events are applied strictly in `seq` order; a gap triggers a resync.
 * - Reconnects use exponential backoff with jitter.
 */
export class BoardSession {
  /**
   * @param {{ boardId: string, token: string, name: string, handlers: {
   *   onChange: () => void,
   *   onStatus: (status: { state: string, pending: number }) => void,
   *   onPresence: (users: object[], selfId: string) => void,
   *   onRejected: (op: object, result: object) => void,
   *   onUnauthorized: (reason: string) => void,
   *   onRole: (role: string) => void,
   * }}} options
   */
  constructor({ boardId, token, name, handlers }) {
    this.boardId = boardId;
    this.token = token;
    this.name = name;
    this.handlers = handlers;
    this.ws = null;
    this.state = 'connecting';
    this.joined = false;
    this.role = null;
    this.connectionId = null;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastMessageAt = 0;
    this.resyncing = false;
    this.closed = false;
    /** opId -> requestId for operations sent on the current connection */
    this.sent = new Map();

    const cached = boardCache.load(boardId);
    this.confirmed = cached?.snapshot ? confirmedFromSnapshot(cached.snapshot) : emptyConfirmed();
    this.hasData = Boolean(cached?.snapshot);
    this.pending = Array.isArray(cached?.pending) ? cached.pending : [];

    this.onOnline = () => this.reconnectNow();
    window.addEventListener('online', this.onOnline);
  }

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    window.removeEventListener('online', this.onOnline);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close(1000, 'Leaving board');
  }

  persist() {
    const snapshot = {
      seq: this.confirmed.seq,
      board: this.confirmed.board,
      columns: [...this.confirmed.columns.values()],
      cards: [...this.confirmed.cards.values()],
    };
    boardCache.save(this.boardId, { snapshot, pending: this.pending });
  }

  setState(state) {
    this.state = state;
    this.handlers.onStatus({ state, pending: this.pending.length });
  }

  connect() {
    if (this.closed) return;
    this.setState(navigator.onLine === false ? 'offline' : 'connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ type: 'hello', boardId: this.boardId, token: this.token, name: this.name }));
    });
    ws.addEventListener('message', (event) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleMessage(message);
    });
    ws.addEventListener('close', (event) => this.handleClose(ws, event));
  }

  handleClose(ws, event) {
    if (ws !== this.ws) return;
    clearInterval(this.pingTimer);
    this.joined = false;
    this.sent.clear();
    this.resyncing = false;
    if (this.closed) return;
    if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_REVOKED) {
      this.closed = true;
      this.setState('unauthorized');
      this.handlers.onUnauthorized(event.code === CLOSE_REVOKED ? 'revoked' : 'unauthorized');
      return;
    }
    this.setState(navigator.onLine === false ? 'offline' : 'connecting');
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.closed || this.joined) return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.connect();
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  replaceConfirmed(snapshot) {
    this.confirmed = confirmedFromSnapshot(snapshot);
    this.hasData = true;
    this.resyncing = false;
    this.persist();
    this.handlers.onChange();
  }

  handleMessage(message) {
    switch (message.type) {
      case 'welcome':
        this.joined = true;
        this.attempt = 0;
        this.role = message.role;
        this.connectionId = message.connectionId;
        this.handlers.onRole(message.role);
        if (message.role !== 'editor' && this.pending.length > 0) {
          this.pending = []; // read-only access now: queued edits can never apply
        }
        this.replaceConfirmed(message.snapshot);
        this.setState('online');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.keepAlive(), PING_EVERY_MS);
        this.flush();
        break;
      case 'snapshot':
        this.replaceConfirmed(message.snapshot);
        break;
      case 'event': {
        if (this.resyncing) break;
        const outcome = applyEvent(this.confirmed, message);
        if (outcome === 'gap') {
          this.resyncing = true;
          this.send({ type: 'resync' });
          break;
        }
        if (outcome === 'applied') {
          this.removePending(message.opId);
          this.persist();
          this.handlers.onChange();
        }
        break;
      }
      case 'ack':
        this.handleAck(message);
        break;
      case 'presence':
        this.handlers.onPresence(message.users, this.connectionId);
        break;
      default:
        break;
    }
  }

  handleAck(message) {
    const opIds = [...this.sent].filter(([, requestId]) => requestId === message.requestId).map(([opId]) => opId);
    opIds.forEach((opId) => this.sent.delete(opId));
    if (message.error === 'rate_limited') {
      setTimeout(() => this.flush(), message.retryAfterMs || 2000);
      return;
    }
    if (message.error) {
      // The whole batch was refused (e.g. read-only token): drop it.
      for (const opId of opIds) {
        const op = this.pending.find((p) => p.opId === opId);
        if (op) this.handlers.onRejected(op, { status: 'rejected', error: message.message });
        this.removePending(opId);
      }
    } else {
      for (const result of message.results || []) {
        const op = this.pending.find((p) => p.opId === result.opId);
        if (result.status === 'conflict' || result.status === 'rejected') {
          if (result.current) this.adoptCurrent(result);
          if (op) this.handlers.onRejected(op, result);
        }
        this.removePending(result.opId);
      }
    }
    this.persist();
    this.handlers.onChange();
    this.flush();
  }

  /** A conflict carries the server's current entity; use it if it is newer. */
  adoptCurrent(result) {
    const entity = result.current;
    if (!entity || entity.seq > this.confirmed.seq) return; // a later event will bring it
    const map = 'columnId' in entity ? this.confirmed.cards : this.confirmed.columns;
    if (entity.deleted) map.delete(entity.id);
    else if (!map.has(entity.id) || map.get(entity.id).version < entity.version) map.set(entity.id, entity);
  }

  removePending(opId) {
    const before = this.pending.length;
    this.pending = this.pending.filter((op) => op.opId !== opId);
    if (this.pending.length !== before) this.handlers.onStatus({ state: this.state, pending: this.pending.length });
  }

  /** Queues a local operation and sends it when possible. */
  submit(op) {
    const withId = { ...op, opId: uid() };
    this.pending.push(withId);
    this.persist();
    this.handlers.onChange();
    this.handlers.onStatus({ state: this.state, pending: this.pending.length });
    this.flush();
    return withId;
  }

  flush() {
    if (!this.joined) return;
    const unsent = this.pending.filter((op) => !this.sent.has(op.opId));
    let batch = [];
    let bytes = 0;
    const sendBatch = () => {
      if (batch.length === 0) return true;
      const requestId = uid();
      if (!this.send({ type: 'ops', requestId, ops: batch })) return false;
      batch.forEach((op) => this.sent.set(op.opId, requestId));
      batch = [];
      bytes = 0;
      return true;
    };
    for (const op of unsent) {
      const size = encoder.encode(JSON.stringify(op)).length;
      if (batch.length >= MAX_BATCH || (batch.length > 0 && bytes + size > MAX_BATCH_BYTES)) {
        if (!sendBatch()) return;
      }
      batch.push(op);
      bytes += size;
    }
    sendBatch();
  }

  setName(name) {
    this.name = name;
    this.send({ type: 'presence', name });
  }

  keepAlive() {
    if (Date.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
      // The connection is silently dead (sleep, network switch): recycle it now
      // instead of waiting for the browser to notice.
      const ws = this.ws;
      this.handleClose(ws, { code: 1006 });
      ws.close();
      return;
    }
    this.send({ type: 'ping' });
  }
}
