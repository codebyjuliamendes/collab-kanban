'use strict';

const Rank = require('../../shared/rank');

/**
 * Schema migrations, tracked with SQLite's `user_version` header field.
 * Each entry runs once, inside a transaction, in order.
 */
const MIGRATIONS = [
  {
    name: '001_boards_tokens_ranks',
    up(db) {
      const legacy = hasColumn(db, 'cards', 'boardId');
      if (legacy) {
        db.run('ALTER TABLE cards RENAME TO legacy_cards');
        db.run('ALTER TABLE columns RENAME TO legacy_columns');
        db.run('DROP INDEX IF EXISTS idx_cards_board_deleted');
        db.run('DROP INDEX IF EXISTS idx_columns_board_deleted');
      }

      db.run(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`);
      db.run(`
        CREATE TABLE board_tokens (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id),
          role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        )`);
      db.run(`
        CREATE TABLE columns (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id),
          title TEXT NOT NULL,
          rank TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          deleted INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          updated_seq INTEGER NOT NULL DEFAULT 0
        )`);
      db.run(`
        CREATE TABLE cards (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id),
          column_id TEXT NOT NULL REFERENCES columns(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          rank TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          deleted INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          updated_seq INTEGER NOT NULL DEFAULT 0
        )`);
      db.run(`
        CREATE TABLE applied_ops (
          board_id TEXT NOT NULL,
          op_id TEXT NOT NULL,
          result TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (board_id, op_id)
        )`);
      db.run('CREATE INDEX idx_columns_board ON columns (board_id, deleted)');
      db.run('CREATE INDEX idx_cards_board ON cards (board_id, deleted)');
      db.run('CREATE INDEX idx_cards_column ON cards (column_id, deleted, rank)');
      db.run('CREATE INDEX idx_tokens_board ON board_tokens (board_id)');
      db.run('CREATE INDEX idx_applied_ops_created ON applied_ops (created_at)');

      if (legacy) importLegacyRows(db);
    },
  },
];

function hasColumn(db, table, column) {
  const exists = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $table", { $table: table });
  if (!exists) return false;
  return db.all(`PRAGMA table_info(${table})`).some((info) => info.name === column);
}

/**
 * Brings data from the first version (single global board, float order,
 * client timestamps) into the new schema. Boards are created without tokens;
 * use `npm run board:invite` to issue one for them.
 */
function importLegacyRows(db) {
  const now = Date.now();
  const columns = db.all('SELECT * FROM legacy_columns WHERE isDeleted = 0 ORDER BY boardId, orderIndex, id');
  const cards = db.all('SELECT * FROM legacy_cards WHERE isDeleted = 0 ORDER BY columnId, orderIndex, id');
  const boardIds = new Set([...columns.map((c) => c.boardId), ...cards.map((c) => c.boardId)]);
  for (const boardId of boardIds) {
    db.run('INSERT INTO boards (id, title, seq, created_at) VALUES ($id, $title, 0, $now)', {
      $id: boardId,
      $title: boardId,
      $now: now,
    });
    const boardColumns = columns.filter((c) => c.boardId === boardId);
    const ranks = Rank.evenlySpaced(boardColumns.length);
    boardColumns.forEach((column, index) => {
      db.run(
        `INSERT INTO columns (id, board_id, title, rank, version, deleted, updated_at)
         VALUES ($id, $boardId, $title, $rank, 1, 0, $now)`,
        { $id: column.id, $boardId: boardId, $title: column.title || 'Untitled', $rank: ranks[index], $now: now },
      );
    });
    const columnIds = new Set(boardColumns.map((c) => c.id));
    for (const columnId of columnIds) {
      const columnCards = cards.filter((c) => c.columnId === columnId && c.boardId === boardId);
      const cardRanks = Rank.evenlySpaced(columnCards.length);
      columnCards.forEach((card, index) => {
        db.run(
          `INSERT INTO cards (id, board_id, column_id, title, description, rank, version, deleted, updated_at)
           VALUES ($id, $boardId, $columnId, $title, $description, $rank, 1, 0, $now)`,
          {
            $id: card.id,
            $boardId: boardId,
            $columnId: columnId,
            $title: card.title || 'Untitled',
            $description: card.description || '',
            $rank: cardRanks[index],
            $now: now,
          },
        );
      });
    }
  }
  db.run('DROP TABLE legacy_cards');
  db.run('DROP TABLE legacy_columns');
}

/**
 * Applies pending migrations.
 * @param {import('./database').Database} db
 * @returns {string[]} names of the migrations that ran
 */
function migrate(db) {
  const current = db.get('PRAGMA user_version').user_version;
  const applied = [];
  MIGRATIONS.forEach((migration, index) => {
    const version = index + 1;
    if (version <= current) return;
    db.transaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version = ${version}`);
    });
    applied.push(migration.name);
  });
  return applied;
}

module.exports = { migrate };
