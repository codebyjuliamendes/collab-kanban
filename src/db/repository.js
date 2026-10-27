'use strict';

/**
 * Data access for boards, columns, cards, tokens and the idempotency log.
 * Functions take the Database explicitly and never decide business rules.
 */

const toColumn = (row) =>
  row && {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    rank: row.rank,
    version: row.version,
    deleted: row.deleted === 1,
    updatedAt: row.updated_at,
    seq: row.updated_seq,
  };

const toCard = (row) =>
  row && {
    id: row.id,
    boardId: row.board_id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    rank: row.rank,
    version: row.version,
    deleted: row.deleted === 1,
    updatedAt: row.updated_at,
    seq: row.updated_seq,
  };

const toBoard = (row) => row && { id: row.id, title: row.title, seq: row.seq, createdAt: row.created_at };

function createRepository(db) {
  return {
    insertBoard({ id, title, now }) {
      db.run('INSERT INTO boards (id, title, seq, created_at) VALUES ($id, $title, 0, $now)', {
        $id: id,
        $title: title,
        $now: now,
      });
    },
    getBoard(id) {
      return toBoard(db.get('SELECT * FROM boards WHERE id = $id', { $id: id }));
    },
    nextSeq(boardId) {
      db.run('UPDATE boards SET seq = seq + 1 WHERE id = $id', { $id: boardId });
      return db.get('SELECT seq FROM boards WHERE id = $id', { $id: boardId }).seq;
    },

    insertToken({ id, boardId, role, tokenHash, now }) {
      db.run(
        `INSERT INTO board_tokens (id, board_id, role, token_hash, created_at)
         VALUES ($id, $boardId, $role, $hash, $now)`,
        { $id: id, $boardId: boardId, $role: role, $hash: tokenHash, $now: now },
      );
    },
    findActiveToken(boardId, tokenHash) {
      return db.get(
        `SELECT id, role FROM board_tokens
         WHERE board_id = $boardId AND token_hash = $hash AND revoked_at IS NULL`,
        { $boardId: boardId, $hash: tokenHash },
      );
    },
    revokeTokens({ boardId, role, exceptId, now }) {
      return db.run(
        `UPDATE board_tokens SET revoked_at = $now
         WHERE board_id = $boardId AND role = $role AND revoked_at IS NULL AND id != $exceptId`,
        { $boardId: boardId, $role: role, $exceptId: exceptId, $now: now },
      );
    },

    listColumns(boardId) {
      return db
        .all('SELECT * FROM columns WHERE board_id = $boardId AND deleted = 0', { $boardId: boardId })
        .map(toColumn);
    },
    getColumn(id) {
      return toColumn(db.get('SELECT * FROM columns WHERE id = $id', { $id: id }));
    },
    insertColumn(column) {
      db.run(
        `INSERT INTO columns (id, board_id, title, rank, version, deleted, updated_at, updated_seq)
         VALUES ($id, $boardId, $title, $rank, 1, 0, $now, $seq)`,
        {
          $id: column.id,
          $boardId: column.boardId,
          $title: column.title,
          $rank: column.rank,
          $now: column.updatedAt,
          $seq: column.seq,
        },
      );
    },
    updateColumn(column) {
      db.run(
        `UPDATE columns SET title = $title, rank = $rank, version = $version, deleted = $deleted,
           updated_at = $now, updated_seq = $seq
         WHERE id = $id`,
        {
          $id: column.id,
          $title: column.title,
          $rank: column.rank,
          $version: column.version,
          $deleted: column.deleted ? 1 : 0,
          $now: column.updatedAt,
          $seq: column.seq,
        },
      );
    },

    listCards(boardId) {
      return db.all('SELECT * FROM cards WHERE board_id = $boardId AND deleted = 0', { $boardId: boardId }).map(toCard);
    },
    countCards(boardId) {
      return db.get('SELECT COUNT(*) AS n FROM cards WHERE board_id = $boardId AND deleted = 0', { $boardId: boardId })
        .n;
    },
    listCardsInColumn(columnId) {
      return db
        .all('SELECT * FROM cards WHERE column_id = $columnId AND deleted = 0', { $columnId: columnId })
        .map(toCard);
    },
    getCard(id) {
      return toCard(db.get('SELECT * FROM cards WHERE id = $id', { $id: id }));
    },
    idTaken(id) {
      return Boolean(
        db.get('SELECT 1 AS hit FROM cards WHERE id = $id UNION ALL SELECT 1 FROM columns WHERE id = $id', { $id: id }),
      );
    },
    insertCard(card) {
      db.run(
        `INSERT INTO cards (id, board_id, column_id, title, description, rank, version, deleted, updated_at, updated_seq)
         VALUES ($id, $boardId, $columnId, $title, $description, $rank, 1, 0, $now, $seq)`,
        {
          $id: card.id,
          $boardId: card.boardId,
          $columnId: card.columnId,
          $title: card.title,
          $description: card.description,
          $rank: card.rank,
          $now: card.updatedAt,
          $seq: card.seq,
        },
      );
    },
    updateCard(card) {
      db.run(
        `UPDATE cards SET column_id = $columnId, title = $title, description = $description, rank = $rank,
           version = $version, deleted = $deleted, updated_at = $now, updated_seq = $seq
         WHERE id = $id`,
        {
          $id: card.id,
          $columnId: card.columnId,
          $title: card.title,
          $description: card.description,
          $rank: card.rank,
          $version: card.version,
          $deleted: card.deleted ? 1 : 0,
          $now: card.updatedAt,
          $seq: card.seq,
        },
      );
    },

    findAppliedOp(boardId, opId) {
      const row = db.get('SELECT result FROM applied_ops WHERE board_id = $boardId AND op_id = $opId', {
        $boardId: boardId,
        $opId: opId,
      });
      return row ? JSON.parse(row.result) : null;
    },
    recordAppliedOp({ boardId, opId, result, now }) {
      db.run('INSERT INTO applied_ops (board_id, op_id, result, created_at) VALUES ($boardId, $opId, $result, $now)', {
        $boardId: boardId,
        $opId: opId,
        $result: JSON.stringify(result),
        $now: now,
      });
    },
    pruneAppliedOps(olderThan) {
      return db.run('DELETE FROM applied_ops WHERE created_at < $olderThan', { $olderThan: olderThan });
    },
  };
}

module.exports = { createRepository };
