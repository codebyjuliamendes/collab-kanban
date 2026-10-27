'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { Database } = require('../src/db/database');
const { createBoardService } = require('../src/domain/board-service');
const { silentLogger } = require('./helpers');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

test('data survives a restart (atomic save on close)', async () => {
  const dir = tmpDir();
  const db1 = await Database.open({ dataDir: dir, debounceMs: 10_000, logger: silentLogger });
  const service1 = createBoardService({ db: db1 });
  const { board, editorToken } = service1.createBoard('Persistent');
  const editor = service1.authorize(board.id, editorToken);
  service1.applyOps(board.id, [{ opId: 'o1', type: 'column.create', id: 'todo', title: 'Todo' }], editor);
  db1.close();

  const db2 = await Database.open({ dataDir: dir, logger: silentLogger });
  const service2 = createBoardService({ db: db2 });
  assert.equal(service2.authorize(board.id, editorToken).role, 'editor');
  const snapshot = service2.getSnapshot(board.id);
  assert.equal(snapshot.columns[0].title, 'Todo');
  assert.equal(snapshot.seq, 1);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
  );
  db2.close();
});

test('a failed transaction leaves no partial writes', async () => {
  const db = await Database.open({ dataDir: null, logger: silentLogger });
  assert.throws(() =>
    db.transaction(() => {
      db.run("INSERT INTO boards (id, title, seq, created_at) VALUES ('b1', 't', 0, 0)");
      throw new Error('boom');
    }),
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM boards').n, 0);
});

test('a database from the first version is migrated with its cards in order', async () => {
  const dir = tmpDir();
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE cards (id TEXT PRIMARY KEY, boardId TEXT NOT NULL, columnId TEXT NOT NULL, title TEXT,
    description TEXT, assignees TEXT, labels TEXT, orderIndex REAL, isDeleted INTEGER DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  legacy.run(`CREATE TABLE columns (id TEXT PRIMARY KEY, boardId TEXT NOT NULL, title TEXT, orderIndex REAL,
    isDeleted INTEGER DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  legacy.run(`INSERT INTO columns VALUES ('col_b', 'default-board', 'Done', 20, 0, 1), ('col_a', 'default-board', 'Todo', 10, 0, 1),
    ('col_x', 'default-board', 'Gone', 30, 1, 1)`);
  legacy.run(`INSERT INTO cards VALUES
    ('k2', 'default-board', 'col_a', 'Second', '', '[]', '[]', 15, 0, 1),
    ('k1', 'default-board', 'col_a', 'First', 'desc', '[]', '[]', 5, 0, 1),
    ('k3', 'default-board', 'col_b', 'Third', '', '[]', '[]', 1, 0, 1),
    ('k4', 'default-board', 'col_b', 'Deleted', '', '[]', '[]', 2, 1, 1)`);
  fs.writeFileSync(path.join(dir, 'kanban.db'), Buffer.from(legacy.export()));

  const db = await Database.open({ dataDir: dir, logger: silentLogger });
  const service = createBoardService({ db });
  const snapshot = service.getSnapshot('default-board');
  assert.deepEqual(
    snapshot.columns.map((c) => c.title),
    ['Todo', 'Done'],
  );
  assert.deepEqual(
    snapshot.cards.filter((c) => c.columnId === 'col_a').map((c) => c.title),
    ['First', 'Second'],
  );
  assert.equal(snapshot.cards.length, 3);
  assert.equal(snapshot.cards.find((c) => c.id === 'k1').description, 'desc');

  const token = service.issueTokenAsOperator('default-board', 'editor');
  assert.equal(service.authorize('default-board', token).role, 'editor');
  db.close();
});
