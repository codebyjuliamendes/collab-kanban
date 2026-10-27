'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const request = require('supertest');
const { startServer } = require('../src/server');
const { silentLogger } = require('./helpers');

async function boot() {
  const app = await startServer({
    env: { NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' },
    dataDir: null,
    logger: silentLogger,
  });
  const { body } = await request(app.server).post('/api/boards').send({ title: 'Live' }).expect(201);
  return { ...app, ...body, url: `ws://127.0.0.1:${app.port}/ws` };
}

/** Test client that records every message and lets tests await specific ones. */
function connect(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const next = (match, timeoutMs = 2000) =>
    new Promise((resolve, reject) => {
      const found = messages.find(match);
      if (found) {
        messages.splice(messages.indexOf(found), 1);
        return resolve(found);
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          messages.splice(messages.indexOf(message), 1);
          resolve(message);
        },
      });
      return undefined;
    });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const send = (message) => ws.send(JSON.stringify(message));
  return { ws, next, closed, opened, send, messages };
}

async function join(url, boardId, token, name) {
  const client = connect(url);
  await client.opened;
  client.send({ type: 'hello', boardId, token, name });
  const welcome = await client.next((m) => m.type === 'welcome');
  return { ...client, welcome };
}

const byType = (type) => (m) => m.type === type;

test('clients get a snapshot on join and see each other’s events in seq order', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const alice = await join(app.url, app.board.id, app.editorToken, 'Alice');
  const bob = await join(app.url, app.board.id, app.viewerToken, 'Bob');
  assert.equal(alice.welcome.role, 'editor');
  assert.equal(bob.welcome.role, 'viewer');
  assert.equal(bob.welcome.snapshot.seq, 0);

  const presence = await alice.next((m) => m.type === 'presence' && m.users.length === 2);
  assert.deepEqual(presence.users.map((u) => u.name).sort(), ['Alice', 'Bob']);

  alice.send({
    type: 'ops',
    requestId: 'r1',
    ops: [
      { opId: 'o1', type: 'column.create', id: 'todo', title: 'Todo' },
      { opId: 'o2', type: 'card.create', id: 'c1', columnId: 'todo', title: 'Hello' },
    ],
  });
  const e1 = await bob.next(byType('event'));
  const e2 = await bob.next(byType('event'));
  assert.deepEqual([e1.seq, e2.seq], [1, 2]);
  assert.equal(e2.changes[0].entity.title, 'Hello');

  // The sender receives its own events before the ack.
  const ownEvents = [await alice.next(byType('event')), await alice.next(byType('event'))];
  assert.deepEqual(
    ownEvents.map((e) => e.opId),
    ['o1', 'o2'],
  );
  const ack = await alice.next(byType('ack'));
  assert.deepEqual(
    ack.results.map((r) => r.status),
    ['applied', 'applied'],
  );
  alice.ws.close();
  bob.ws.close();
});

test('viewers cannot write over the socket', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const viewer = await join(app.url, app.board.id, app.viewerToken);
  viewer.send({ type: 'ops', requestId: 'r1', ops: [{ opId: 'o1', type: 'column.create', id: 'x', title: 'x' }] });
  const ack = await viewer.next(byType('ack'));
  assert.equal(ack.error, 'forbidden');
  viewer.ws.close();
});

test('bad tokens and silent clients are disconnected', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const intruder = connect(app.url);
  await intruder.opened;
  intruder.send({ type: 'hello', boardId: app.board.id, token: 'kbt_' + 'a'.repeat(43) });
  assert.equal(await intruder.closed, 4001);

  const early = connect(app.url);
  await early.opened;
  early.send({ type: 'ops', requestId: 'r', ops: [{}] });
  assert.equal(await early.closed, 4003);
});

test('cross-origin browser connections are refused', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const evil = connect(app.url, { Origin: 'https://evil.example' });
  await assert.rejects(evil.opened, /403/);
  const same = connect(app.url, { Origin: `http://127.0.0.1:${app.port}` });
  await same.opened;
  same.ws.close();
});

test('revoking tokens closes their live sessions', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const viewer = await join(app.url, app.board.id, app.viewerToken);
  await request(app.server)
    .post(`/api/boards/${app.board.id}/invites/revoke`)
    .set('Authorization', `Bearer ${app.editorToken}`)
    .send({ role: 'viewer' })
    .expect(200);
  assert.equal(await viewer.closed, 4004);
});

test('REST writes are broadcast to socket clients and resync returns a snapshot', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const client = await join(app.url, app.board.id, app.viewerToken);
  await request(app.server)
    .post(`/api/boards/${app.board.id}/ops`)
    .set('Authorization', `Bearer ${app.editorToken}`)
    .send({ ops: [{ opId: 'o1', type: 'column.create', id: 'todo', title: 'Todo' }] })
    .expect(200);
  const event = await client.next(byType('event'));
  assert.equal(event.seq, 1);
  client.send({ type: 'resync' });
  const snapshot = await client.next(byType('snapshot'));
  assert.equal(snapshot.snapshot.seq, 1);
  assert.equal(snapshot.snapshot.columns[0].id, 'todo');
  client.ws.close();
});

test('malformed messages get an error instead of crashing the connection', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const client = await join(app.url, app.board.id, app.editorToken);
  client.ws.send('not json');
  assert.equal((await client.next(byType('error'))).code, 'bad_message');
  client.send({ type: 'ping' });
  await client.next(byType('pong'));
  client.ws.close();
});

test('shutdown closes sockets with 1001 so clients reconnect', async () => {
  const app = await boot();
  const client = await join(app.url, app.board.id, app.editorToken);
  await app.stop();
  assert.equal(await client.closed, 1001);
});
