'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestService } = require('./helpers');

globalThis.Rank = require('../shared/rank');

const load = () => import('../public/js/state.js');

test('pending operations are shown on top of confirmed state', async () => {
  const { confirmedFromSnapshot, view } = await load();
  const confirmed = confirmedFromSnapshot({
    seq: 1,
    board: { id: 'b', title: 'B' },
    columns: [{ id: 'todo', title: 'Todo', rank: 'V', version: 1 }],
    cards: [],
  });
  const pending = [
    { opId: '1', type: 'card.create', id: 'c1', columnId: 'todo', title: 'One' },
    { opId: '2', type: 'card.create', id: 'c2', columnId: 'todo', title: 'Two', afterId: null },
    { opId: '3', type: 'card.update', id: 'c1', baseVersion: 1, title: 'One!' },
  ];
  const state = view(confirmed, pending);
  assert.deepEqual(
    state.columns[0].cards.map((c) => c.title),
    ['Two', 'One!'],
  );
  assert.equal(state.cards.get('c1').version, 2);
});

test('events must arrive in seq order; gaps are detected', async () => {
  const { applyEvent, emptyConfirmed } = await load();
  const confirmed = emptyConfirmed();
  const column = { id: 'todo', title: 'Todo', rank: 'V', version: 1 };
  assert.equal(applyEvent(confirmed, { seq: 1, changes: [{ kind: 'column', entity: column }] }), 'applied');
  assert.equal(applyEvent(confirmed, { seq: 1, changes: [] }), 'stale');
  assert.equal(applyEvent(confirmed, { seq: 3, changes: [] }), 'gap');
  assert.equal(
    applyEvent(confirmed, { seq: 2, changes: [{ kind: 'column', entity: { ...column, deleted: true } }] }),
    'applied',
  );
  assert.equal(confirmed.columns.size, 0);
});

test('an operation already applied by the server is not applied twice when rebased', async () => {
  const { confirmedFromSnapshot, view } = await load();
  // Server state after the update was applied but before the ack arrived.
  const confirmed = confirmedFromSnapshot({
    seq: 3,
    board: null,
    columns: [{ id: 'todo', title: 'Todo', rank: 'V', version: 1 }],
    cards: [{ id: 'c1', columnId: 'todo', title: 'Edited', description: '', rank: 'V', version: 2 }],
  });
  const state = view(confirmed, [
    { opId: 'o', type: 'card.update', id: 'c1', baseVersion: 1, title: 'Edited' },
    { opId: 'p', type: 'card.create', id: 'c1', columnId: 'todo', title: 'dup' },
  ]);
  assert.equal(state.cards.get('c1').version, 2);
  assert.equal(state.columns[0].cards.length, 1);
});

test('anchorAt() and keyboardTarget() compute keyboard and drop positions', async () => {
  const { anchorAt, keyboardTarget } = await load();
  assert.deepEqual(anchorAt(['a', 'b'], 0), { afterId: null, beforeId: 'a' });
  assert.deepEqual(anchorAt(['a', 'b'], 1), { afterId: 'a', beforeId: 'b' });
  assert.deepEqual(anchorAt(['a', 'b'], 2), { afterId: 'b' });
  assert.deepEqual(anchorAt([], 5), { afterId: null });

  const columns = [
    { id: 'c1', cards: [{ id: 'x' }, { id: 'y' }] },
    { id: 'c2', cards: [{ id: 'z' }] },
  ];
  assert.deepEqual(keyboardTarget(columns, { columnIndex: 0, index: 0 }, 'down', 'x'), { columnIndex: 0, index: 1 });
  assert.deepEqual(keyboardTarget(columns, { columnIndex: 0, index: 1 }, 'down', 'x'), { columnIndex: 0, index: 1 });
  assert.deepEqual(keyboardTarget(columns, { columnIndex: 0, index: 1 }, 'right', 'x'), { columnIndex: 1, index: 1 });
  assert.deepEqual(keyboardTarget(columns, { columnIndex: 1, index: 0 }, 'right', 'x'), { columnIndex: 1, index: 0 });
  assert.deepEqual(keyboardTarget(columns, { columnIndex: 0, index: 1 }, 'top', 'x'), { columnIndex: 0, index: 0 });
});

test('two clients editing concurrently converge to the server order', async () => {
  const { confirmedFromSnapshot, applyEvent, view, anchorAt } = await load();
  const { service } = await createTestService();
  const { board, editorToken } = service.createBoard('Converge');
  const access = service.authorize(board.id, editorToken);
  service.applyOps(
    board.id,
    [
      { opId: 's1', type: 'column.create', id: 'todo', title: 'Todo' },
      ...['a', 'b', 'c', 'd'].map((id, i) => ({
        opId: `s${i + 2}`,
        type: 'card.create',
        id,
        columnId: 'todo',
        title: id,
      })),
    ],
    access,
  );
  const snapshot = service.getSnapshot(board.id);
  const clientA = { confirmed: confirmedFromSnapshot(snapshot), pending: [] };
  const clientB = { confirmed: confirmedFromSnapshot(snapshot), pending: [] };

  // Both users move a different card to the top at the same time, offline from each other.
  const ids = (client, except) =>
    view(client.confirmed, client.pending)
      .columns[0].cards.map((c) => c.id)
      .filter((id) => id !== except);
  clientA.pending.push({ opId: 'A1', type: 'card.move', id: 'c', columnId: 'todo', ...anchorAt(ids(clientA, 'c'), 0) });
  clientB.pending.push({ opId: 'B1', type: 'card.move', id: 'd', columnId: 'todo', ...anchorAt(ids(clientB, 'd'), 0) });

  // The server receives A first, then B; both clients get both events.
  const events = [
    ...service.applyOps(board.id, clientA.pending, access).events,
    ...service.applyOps(board.id, clientB.pending, access).events,
  ];
  for (const client of [clientA, clientB]) {
    for (const event of events) {
      assert.equal(applyEvent(client.confirmed, event), 'applied');
      client.pending = client.pending.filter((op) => op.opId !== event.opId);
    }
  }
  const server = service.getSnapshot(board.id).cards.map((c) => c.id);
  assert.deepEqual(server, ['d', 'c', 'a', 'b']);
  assert.deepEqual(ids(clientA), server);
  assert.deepEqual(ids(clientB), server);
});
