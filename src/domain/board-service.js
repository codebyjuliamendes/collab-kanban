'use strict';

const crypto = require('node:crypto');
const Rank = require('../../shared/rank');
const { createRepository } = require('../db/repository');
const { parseOp, LIMITS } = require('./ops');
const { generateToken, hashToken, isWellFormedToken } = require('./tokens');
const { unauthorized, forbidden, notFound } = require('../errors');

const ROLES = Object.freeze(['editor', 'viewer']);
const APPLIED_OP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Board use cases: creation, authorization, snapshots and applying operations.
 *
 * Consistency model
 * - Every applied operation gets the next per-board sequence number (`seq`).
 *   Clients apply events in seq order and resynchronise on any gap.
 * - Positions are fractional ranks computed by the server from its own state,
 *   so concurrent moves always converge to one total order.
 * - Content edits (title, description, delete) carry the `baseVersion` the
 *   client saw. A mismatch is a conflict: nothing is overwritten silently.
 * - `opId` makes every operation idempotent, so queued operations can be
 *   retried after a reconnect without being applied twice.
 */
function createBoardService({ db, clock = () => Date.now() }) {
  const repo = createRepository(db);

  function createBoard(title) {
    const now = clock();
    const board = { id: crypto.randomUUID(), title };
    const editorToken = generateToken();
    const viewerToken = generateToken();
    db.transaction(() => {
      repo.insertBoard({ ...board, now });
      repo.insertToken({
        id: crypto.randomUUID(),
        boardId: board.id,
        role: 'editor',
        tokenHash: hashToken(editorToken),
        now,
      });
      repo.insertToken({
        id: crypto.randomUUID(),
        boardId: board.id,
        role: 'viewer',
        tokenHash: hashToken(viewerToken),
        now,
      });
    });
    return { board, editorToken, viewerToken };
  }

  /**
   * @returns {{ role: 'editor'|'viewer', tokenId: string }}
   * @throws {AppError} 401 for unknown boards and bad tokens alike (no board enumeration)
   */
  function authorize(boardId, token) {
    if (!isWellFormedToken(token)) throw unauthorized();
    const row = repo.findActiveToken(boardId, hashToken(token));
    if (!row) throw unauthorized();
    return { role: row.role, tokenId: row.id };
  }

  function requireEditor(access) {
    if (access.role !== 'editor') throw forbidden();
  }

  function issueToken(boardId, access, role) {
    requireEditor(access);
    if (!ROLES.includes(role)) throw notFound('Unknown role');
    const token = generateToken();
    db.transaction(() => {
      repo.insertToken({ id: crypto.randomUUID(), boardId, role, tokenHash: hashToken(token), now: clock() });
    });
    return token;
  }

  /** Revokes every token of `role` except the one making the request. */
  function revokeTokens(boardId, access, role) {
    requireEditor(access);
    if (!ROLES.includes(role)) throw notFound('Unknown role');
    return db.transaction(() => repo.revokeTokens({ boardId, role, exceptId: access.tokenId, now: clock() }));
  }

  function getSnapshot(boardId) {
    const board = repo.getBoard(boardId);
    if (!board) throw notFound('Board not found');
    return {
      board: { id: board.id, title: board.title },
      seq: board.seq,
      columns: repo.listColumns(boardId).sort(Rank.compare),
      cards: repo.listCards(boardId).sort(Rank.compare),
    };
  }

  // --- operation handlers: return an outcome, never write -----------------

  const rejected = (error, code = 'rejected') => ({ status: 'rejected', code, error });
  const conflict = (current, error) => ({ status: 'conflict', code: 'conflict', error, current });
  const noop = () => ({ status: 'noop' });

  function ownColumn(boardId, columnId) {
    const column = repo.getColumn(columnId);
    return column && column.boardId === boardId ? column : null;
  }
  function ownCard(boardId, cardId) {
    const card = repo.getCard(cardId);
    return card && card.boardId === boardId ? card : null;
  }

  function placeWithRebalance(kind, siblings, anchor) {
    const placed = Rank.place(siblings, anchor);
    const extra = [];
    if (placed.rebalanced) {
      const byId = new Map(siblings.map((item) => [item.id, item]));
      for (const { id, rank } of placed.rebalanced) {
        if (id === null) continue;
        const sibling = byId.get(id);
        if (sibling.rank !== rank) extra.push({ kind, entity: { ...sibling, rank } });
      }
    }
    return { rank: placed.rank, extra };
  }

  const handlers = {
    'column.create'(boardId, op, now) {
      if (repo.idTaken(op.id)) return rejected('An item with this id already exists', 'id_taken');
      const columns = repo.listColumns(boardId);
      if (columns.length >= LIMITS.columnsPerBoard) return rejected('Column limit reached', 'limit_reached');
      const { rank, extra } = placeWithRebalance('column', columns, op);
      const entity = { id: op.id, boardId, title: op.title, rank, version: 1, deleted: false, updatedAt: now };
      return { status: 'applied', changes: [{ kind: 'column', entity, isNew: true }, ...extra] };
    },
    'column.update'(boardId, op, now) {
      const column = ownColumn(boardId, op.id);
      if (!column) return rejected('Column not found', 'not_found');
      if (column.deleted) return conflict(column, 'Column was deleted');
      if (column.version !== op.baseVersion) return conflict(column, 'Column was changed by someone else');
      if (column.title === op.title) return noop();
      const entity = { ...column, title: op.title, version: column.version + 1, updatedAt: now };
      return { status: 'applied', changes: [{ kind: 'column', entity }] };
    },
    'column.move'(boardId, op, now) {
      const column = ownColumn(boardId, op.id);
      if (!column) return rejected('Column not found', 'not_found');
      if (column.deleted) return conflict(column, 'Column was deleted');
      const siblings = repo.listColumns(boardId).filter((c) => c.id !== column.id);
      const { rank, extra } = placeWithRebalance('column', siblings, op);
      if (rank === column.rank) return noop();
      return {
        status: 'applied',
        changes: [{ kind: 'column', entity: { ...column, rank, updatedAt: now } }, ...extra],
      };
    },
    'column.delete'(boardId, op, now) {
      const column = ownColumn(boardId, op.id);
      if (!column) return rejected('Column not found', 'not_found');
      if (column.deleted) return noop();
      if (op.baseVersion !== undefined && column.version !== op.baseVersion) {
        return conflict(column, 'Column was changed by someone else');
      }
      const changes = [
        { kind: 'column', entity: { ...column, deleted: true, version: column.version + 1, updatedAt: now } },
      ];
      for (const card of repo.listCardsInColumn(column.id)) {
        changes.push({ kind: 'card', entity: { ...card, deleted: true, version: card.version + 1, updatedAt: now } });
      }
      return { status: 'applied', changes };
    },
    'card.create'(boardId, op, now) {
      if (repo.idTaken(op.id)) return rejected('An item with this id already exists', 'id_taken');
      const column = ownColumn(boardId, op.columnId);
      if (!column || column.deleted) return rejected('Column not found', 'column_not_found');
      if (repo.countCards(boardId) >= LIMITS.cardsPerBoard) return rejected('Card limit reached', 'limit_reached');
      const { rank, extra } = placeWithRebalance('card', repo.listCardsInColumn(column.id), op);
      const entity = {
        id: op.id,
        boardId,
        columnId: column.id,
        title: op.title,
        description: op.description ?? '',
        rank,
        version: 1,
        deleted: false,
        updatedAt: now,
      };
      return { status: 'applied', changes: [{ kind: 'card', entity, isNew: true }, ...extra] };
    },
    'card.update'(boardId, op, now) {
      const card = ownCard(boardId, op.id);
      if (!card) return rejected('Card not found', 'not_found');
      if (card.deleted) return conflict(card, 'Card was deleted');
      if (card.version !== op.baseVersion) return conflict(card, 'Card was changed by someone else');
      const title = op.title ?? card.title;
      const description = op.description ?? card.description;
      if (title === card.title && description === card.description) return noop();
      const entity = { ...card, title, description, version: card.version + 1, updatedAt: now };
      return { status: 'applied', changes: [{ kind: 'card', entity }] };
    },
    'card.move'(boardId, op, now) {
      const card = ownCard(boardId, op.id);
      if (!card) return rejected('Card not found', 'not_found');
      if (card.deleted) return conflict(card, 'Card was deleted');
      const column = ownColumn(boardId, op.columnId);
      if (!column || column.deleted) return rejected('Column not found', 'column_not_found');
      const siblings = repo.listCardsInColumn(column.id).filter((c) => c.id !== card.id);
      const { rank, extra } = placeWithRebalance('card', siblings, op);
      if (rank === card.rank && column.id === card.columnId) return noop();
      const entity = { ...card, columnId: column.id, rank, updatedAt: now };
      return { status: 'applied', changes: [{ kind: 'card', entity }, ...extra] };
    },
    'card.delete'(boardId, op, now) {
      const card = ownCard(boardId, op.id);
      if (!card) return rejected('Card not found', 'not_found');
      if (card.deleted) return noop();
      if (op.baseVersion !== undefined && card.version !== op.baseVersion) {
        return conflict(card, 'Card was changed by someone else');
      }
      const entity = { ...card, deleted: true, version: card.version + 1, updatedAt: now };
      return { status: 'applied', changes: [{ kind: 'card', entity }] };
    },
  };

  function persist(change) {
    const { kind, entity, isNew } = change;
    if (kind === 'column') {
      if (isNew) repo.insertColumn(entity);
      else repo.updateColumn(entity);
    } else if (isNew) repo.insertCard(entity);
    else repo.updateCard(entity);
  }

  /**
   * Applies operations in order, each one atomically.
   * @param {string} boardId
   * @param {unknown[]} rawOps
   * @param {{ role: string }} access
   * @returns {{ results: object[], events: object[] }}
   */
  function applyOps(boardId, rawOps, access) {
    requireEditor(access);
    if (!repo.getBoard(boardId)) throw notFound('Board not found');
    const results = [];
    const events = [];
    for (const raw of rawOps) {
      const parsed = parseOp(raw);
      if (!parsed.ok) {
        results.push({ opId: parsed.opId, status: 'rejected', code: 'invalid', error: parsed.error });
        continue;
      }
      const { op } = parsed;
      const previous = repo.findAppliedOp(boardId, op.opId);
      if (previous) {
        results.push({ ...previous, duplicate: true });
        continue;
      }
      const now = clock();
      const outcome = db.transaction(() => {
        const result = handlers[op.type](boardId, op, now);
        if (result.status !== 'applied') return result;
        const seq = repo.nextSeq(boardId);
        const changes = result.changes.map((change) => ({ ...change, entity: { ...change.entity, seq } }));
        changes.forEach(persist);
        repo.recordAppliedOp({ boardId, opId: op.opId, result: { opId: op.opId, status: 'applied', seq }, now });
        return { status: 'applied', seq, changes };
      });
      if (outcome.status === 'applied') {
        const changes = outcome.changes.map(({ kind, entity }) => ({ kind, entity }));
        events.push({ boardId, seq: outcome.seq, opId: op.opId, opType: op.type, changes });
        results.push({ opId: op.opId, status: 'applied', seq: outcome.seq });
      } else {
        const { status, code, error, current } = outcome;
        results.push({
          opId: op.opId,
          status,
          ...(code && { code }),
          ...(error && { error }),
          ...(current && { current }),
        });
      }
    }
    return { results, events };
  }

  function pruneAppliedOps() {
    return db.transaction(() => repo.pruneAppliedOps(clock() - APPLIED_OP_RETENTION_MS));
  }

  /** Issues a token for an existing board (operator CLI, legacy boards). */
  function issueTokenAsOperator(boardId, role) {
    if (!repo.getBoard(boardId)) throw notFound('Board not found');
    if (!ROLES.includes(role)) throw notFound('Unknown role');
    const token = generateToken();
    db.transaction(() => {
      repo.insertToken({ id: crypto.randomUUID(), boardId, role, tokenHash: hashToken(token), now: clock() });
    });
    return token;
  }

  return {
    createBoard,
    authorize,
    issueToken,
    issueTokenAsOperator,
    revokeTokens,
    getSnapshot,
    applyOps,
    pruneAppliedOps,
  };
}

module.exports = { createBoardService, ROLES };
