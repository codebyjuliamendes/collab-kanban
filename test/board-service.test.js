'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestService, nextId } = require('./helpers');

async function setup() {
  const { service, db } = await createTestService();
  const { board, editorToken, viewerToken } = service.createBoard('Team board');
  const editor = service.authorize(board.id, editorToken);
  const apply = (...ops) => service.applyOps(board.id, ops, editor);
  const op = (fields) => ({ opId: nextId('op'), ...fields });
  return { service, db, board, editor, editorToken, viewerToken, apply, op };
}

const columnTitles = (service, boardId) => service.getSnapshot(boardId).columns.map((c) => c.title);
const cardTitles = (service, boardId, columnId) =>
  service
    .getSnapshot(boardId)
    .cards.filter((c) => c.columnId === columnId)
    .map((c) => c.title);

test('creating a board issues distinct editor and viewer tokens', async () => {
  const { service, board, editorToken, viewerToken } = await setup();
  assert.notEqual(editorToken, viewerToken);
  assert.equal(service.authorize(board.id, editorToken).role, 'editor');
  assert.equal(service.authorize(board.id, viewerToken).role, 'viewer');
});

test('authorization is per board and rejects unknown tokens', async () => {
  const { service, board, editorToken } = await setup();
  const other = service.createBoard('Other');
  assert.throws(() => service.authorize(other.board.id, editorToken), { status: 401 });
  assert.throws(() => service.authorize(board.id, 'kbt_' + 'x'.repeat(43)), { status: 401 });
  assert.throws(() => service.authorize(board.id, 'not-a-token'), { status: 401 });
  assert.throws(() => service.authorize('missing-board', editorToken), { status: 401 });
});

test('viewers cannot apply operations', async () => {
  const { service, board, viewerToken, op } = await setup();
  const viewer = service.authorize(board.id, viewerToken);
  assert.throws(() => service.applyOps(board.id, [op({ type: 'column.create', id: 'c1', title: 'Todo' })], viewer), {
    status: 403,
  });
});

test('operations create, order and update columns and cards with increasing seq', async () => {
  const { service, board, apply, op } = await setup();
  const r1 = apply(
    op({ type: 'column.create', id: 'todo', title: 'Todo' }),
    op({ type: 'column.create', id: 'done', title: 'Done' }),
    op({ type: 'column.create', id: 'doing', title: 'Doing', afterId: 'todo' }),
  );
  assert.deepEqual(
    r1.results.map((r) => r.status),
    ['applied', 'applied', 'applied'],
  );
  assert.deepEqual(
    r1.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(columnTitles(service, board.id), ['Todo', 'Doing', 'Done']);

  apply(
    op({ type: 'card.create', id: 'c1', columnId: 'todo', title: 'One' }),
    op({ type: 'card.create', id: 'c2', columnId: 'todo', title: 'Two' }),
    op({ type: 'card.create', id: 'c0', columnId: 'todo', title: 'Zero', afterId: null }),
  );
  assert.deepEqual(cardTitles(service, board.id, 'todo'), ['Zero', 'One', 'Two']);
  assert.equal(service.getSnapshot(board.id).seq, 6);
});

test('card.update with a stale baseVersion is a conflict and does not overwrite', async () => {
  const { service, board, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'todo', title: 'Todo' }));
  apply(op({ type: 'card.create', id: 'c1', columnId: 'todo', title: 'Original' }));

  // Alice and Bob both opened version 1.
  const alice = apply(op({ type: 'card.update', id: 'c1', baseVersion: 1, title: 'Alice' }));
  const bob = apply(op({ type: 'card.update', id: 'c1', baseVersion: 1, title: 'Bob' }));
  assert.equal(alice.results[0].status, 'applied');
  assert.equal(bob.results[0].status, 'conflict');
  assert.equal(bob.results[0].current.title, 'Alice');
  assert.equal(bob.results[0].current.version, 2);
  assert.equal(bob.events.length, 0);
  assert.equal(service.getSnapshot(board.id).cards[0].title, 'Alice');
});

test('moves do not bump the content version, so they never cause edit conflicts', async () => {
  const { apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'a', title: 'A' }), op({ type: 'column.create', id: 'b', title: 'B' }));
  apply(op({ type: 'card.create', id: 'c1', columnId: 'a', title: 'Card' }));
  apply(op({ type: 'card.move', id: 'c1', columnId: 'b' }));
  const edit = apply(op({ type: 'card.update', id: 'c1', baseVersion: 1, description: 'details' }));
  assert.equal(edit.results[0].status, 'applied');
});

test('replaying an opId is idempotent', async () => {
  const { service, board, apply } = await setup();
  const create = { opId: 'same-op', type: 'column.create', id: 'todo', title: 'Todo' };
  const first = apply(create);
  const second = apply(create);
  assert.equal(first.results[0].status, 'applied');
  assert.equal(second.results[0].status, 'applied');
  assert.equal(second.results[0].duplicate, true);
  assert.equal(second.events.length, 0);
  assert.equal(service.getSnapshot(board.id).columns.length, 1);
});

test('concurrent drops into the same slot get distinct ranks and one stable order', async () => {
  const { service, board, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'todo', title: 'Todo' }));
  apply(
    op({ type: 'card.create', id: 'a', columnId: 'todo', title: 'A' }),
    op({ type: 'card.create', id: 'b', columnId: 'todo', title: 'B' }),
    op({ type: 'card.create', id: 'x', columnId: 'todo', title: 'X' }),
    op({ type: 'card.create', id: 'y', columnId: 'todo', title: 'Y' }),
  );
  // Two clients saw [A, B, X, Y] and both drop a card between A and B.
  apply(op({ type: 'card.move', id: 'x', columnId: 'todo', afterId: 'a', beforeId: 'b' }));
  apply(op({ type: 'card.move', id: 'y', columnId: 'todo', afterId: 'a', beforeId: 'b' }));
  const cards = service.getSnapshot(board.id).cards;
  assert.equal(new Set(cards.map((c) => c.rank)).size, cards.length);
  assert.deepEqual(
    cards.map((c) => c.title),
    ['A', 'Y', 'X', 'B'],
  );
});

test('a move whose anchor disappeared falls back to beforeId, then the end', async () => {
  const { service, board, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'todo', title: 'Todo' }));
  apply(
    op({ type: 'card.create', id: 'a', columnId: 'todo', title: 'A' }),
    op({ type: 'card.create', id: 'b', columnId: 'todo', title: 'B' }),
    op({ type: 'card.create', id: 'c', columnId: 'todo', title: 'C' }),
  );
  apply(op({ type: 'card.delete', id: 'a' }));
  apply(op({ type: 'card.move', id: 'c', columnId: 'todo', afterId: 'a', beforeId: 'b' }));
  assert.deepEqual(cardTitles(service, board.id, 'todo'), ['C', 'B']);
});

test('ranks are rebalanced when repeated inserts make them long', async () => {
  const { service, board, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'todo', title: 'Todo' }));
  apply(op({ type: 'card.create', id: 'first', columnId: 'todo', title: 'first' }));
  apply(op({ type: 'card.create', id: 'last', columnId: 'todo', title: 'last' }));
  let rebalanceEvents = 0;
  for (let i = 0; i < 400; i++) {
    const { events } = apply(
      op({ type: 'card.create', id: `n${i}`, columnId: 'todo', title: `n${i}`, afterId: 'first' }),
    );
    if (events[0].changes.length > 1) rebalanceEvents++;
  }
  const cards = service.getSnapshot(board.id).cards;
  assert.ok(rebalanceEvents > 0, 'at least one rebalance happened');
  assert.ok(cards.every((c) => c.rank.length <= 48));
  assert.equal(cards[0].title, 'first');
  assert.equal(cards[1].title, 'n399');
  assert.equal(cards.at(-1).title, 'last');
});

test('ids from another board cannot be touched or reused', async () => {
  const { service, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'mine', title: 'Mine' }));
  apply(op({ type: 'card.create', id: 'secret', columnId: 'mine', title: 'Secret' }));

  const other = service.createBoard('Attacker board');
  const attacker = service.authorize(other.board.id, other.editorToken);
  const attack = (fields) => service.applyOps(other.board.id, [op(fields)], attacker).results[0];

  assert.equal(attack({ type: 'card.update', id: 'secret', baseVersion: 1, title: 'pwned' }).status, 'rejected');
  assert.equal(attack({ type: 'card.delete', id: 'secret' }).status, 'rejected');
  assert.equal(attack({ type: 'column.create', id: 'mine', title: 'dup' }).code, 'id_taken');
  attack({ type: 'column.create', id: 'theirs', title: 'Theirs' });
  assert.equal(attack({ type: 'card.move', id: 'secret', columnId: 'theirs' }).status, 'rejected');
  assert.equal(attack({ type: 'card.create', id: 'new', columnId: 'mine', title: 'x' }).code, 'column_not_found');
});

test('deleting a column deletes its cards in the same event', async () => {
  const { service, board, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'todo', title: 'Todo' }));
  apply(op({ type: 'card.create', id: 'c1', columnId: 'todo', title: 'One' }));
  const { events } = apply(op({ type: 'column.delete', id: 'todo', baseVersion: 1 }));
  assert.equal(events.length, 1);
  assert.deepEqual(
    events[0].changes.map((c) => [c.kind, c.entity.deleted]),
    [
      ['column', true],
      ['card', true],
    ],
  );
  const snapshot = service.getSnapshot(board.id);
  assert.equal(snapshot.columns.length, 0);
  assert.equal(snapshot.cards.length, 0);
  assert.equal(apply(op({ type: 'card.update', id: 'c1', baseVersion: 2, title: 'x' })).results[0].status, 'conflict');
});

test('invalid operations are rejected individually without blocking the batch', async () => {
  const { apply, op } = await setup();
  const { results } = apply(
    op({ type: 'column.create', id: 'ok', title: 'OK' }),
    op({ type: 'column.create', id: 'bad id!', title: 'x' }),
    { type: 'card.create' },
    op({ type: 'column.create', id: 'ok2', title: '   ' }),
    op({ type: 'column.create', id: 'ok3', title: 'Fine' }),
  );
  assert.deepEqual(
    results.map((r) => r.status),
    ['applied', 'rejected', 'rejected', 'rejected', 'applied'],
  );
  assert.equal(results[2].opId, null);
});

test('titles are normalised: control characters and extra whitespace removed', async () => {
  const { service, board, apply, op } = await setup();
  apply(op({ type: 'column.create', id: 'todo', title: '  To\u0000do \n  list ' }));
  assert.equal(service.getSnapshot(board.id).columns[0].title, 'Todo list');
});

test('issued tokens work and revocation keeps only the caller', async () => {
  const { service, board, editor, editorToken } = await setup();
  const second = service.issueToken(board.id, editor, 'editor');
  assert.equal(service.authorize(board.id, second).role, 'editor');
  assert.equal(service.revokeTokens(board.id, editor, 'editor'), 1);
  assert.throws(() => service.authorize(board.id, second), { status: 401 });
  assert.equal(service.authorize(board.id, editorToken).role, 'editor');
});

test('the idempotency log is pruned after the retention window', async () => {
  let now = Date.now();
  const { service } = await createTestService({ clock: () => now });
  const { board, editorToken } = service.createBoard('B');
  const editor = service.authorize(board.id, editorToken);
  service.applyOps(board.id, [{ opId: 'o1', type: 'column.create', id: 'k1', title: 'K' }], editor);
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(service.pruneAppliedOps(), 1);
});

test('boards have a column limit', async () => {
  const { apply, op } = await setup();
  const ops = Array.from({ length: 100 }, (_, i) => op({ type: 'column.create', id: `col${i}`, title: `C${i}` }));
  apply(...ops);
  const { results } = apply(op({ type: 'column.create', id: 'one-too-many', title: 'X' }));
  assert.equal(results[0].code, 'limit_reached');
});
