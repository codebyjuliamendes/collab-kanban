'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startServer } = require('../src/server');
const { silentLogger } = require('./helpers');

async function boot(env = {}) {
  const server = await startServer({
    env: { NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', ...env },
    dataDir: null,
    logger: silentLogger,
  });
  return { ...server, http: request(server.server) };
}

test('health and readiness endpoints', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  await app.http.get('/healthz').expect(200, { status: 'ok' });
  await app.http.get('/readyz').expect(200, { status: 'ready' });
});

test('static pages are served with a strict CSP and security headers', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const res = await app.http.get('/').expect(200);
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-powered-by'], undefined);
  await app.http.get('/shared/rank.js').expect(200);
  await app.http.get('/openapi.json').expect(200);
  await app.http.get('/api-docs/').expect(200);
});

test('board lifecycle over REST: create, read, operate, permissions', async (t) => {
  const app = await boot();
  t.after(() => app.stop());

  const created = await app.http.post('/api/boards').send({ title: 'Launch' }).expect(201);
  const { board, editorToken, viewerToken } = created.body;
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  await app.http.get(`/api/boards/${board.id}`).expect(401);
  await app.http.get(`/api/boards/${board.id}`).set(auth('kbt_wrong')).expect(401);

  const ops = await app.http
    .post(`/api/boards/${board.id}/ops`)
    .set(auth(editorToken))
    .send({ ops: [{ opId: 'o1', type: 'column.create', id: 'todo', title: '<img src=x onerror=alert(1)>' }] })
    .expect(200);
  assert.equal(ops.body.results[0].status, 'applied');

  const snapshot = await app.http.get(`/api/boards/${board.id}`).set(auth(viewerToken)).expect(200);
  assert.equal(snapshot.body.role, 'viewer');
  assert.equal(snapshot.body.seq, 1);
  // Stored verbatim as text; the client renders it with textContent.
  assert.equal(snapshot.body.columns[0].title, '<img src=x onerror=alert(1)>');
  assert.equal(snapshot.headers['cache-control'], 'no-store');

  const forbidden = await app.http
    .post(`/api/boards/${board.id}/ops`)
    .set(auth(viewerToken))
    .send({ ops: [{ opId: 'o2', type: 'column.create', id: 'x', title: 'x' }] })
    .expect(403);
  assert.equal(forbidden.body.error.code, 'forbidden');

  await app.http.post(`/api/boards/${board.id}/invites`).set(auth(viewerToken)).send({ role: 'editor' }).expect(403);
  const invite = await app.http
    .post(`/api/boards/${board.id}/invites`)
    .set(auth(editorToken))
    .send({ role: 'viewer' })
    .expect(201);
  await app.http.get(`/api/boards/${board.id}`).set(auth(invite.body.token)).expect(200);
  const revoke = await app.http
    .post(`/api/boards/${board.id}/invites/revoke`)
    .set(auth(editorToken))
    .send({ role: 'viewer' })
    .expect(200);
  assert.equal(revoke.body.revoked, 2);
  await app.http.get(`/api/boards/${board.id}`).set(auth(viewerToken)).expect(401);
});

test('input validation and error shapes', async (t) => {
  const app = await boot();
  t.after(() => app.stop());
  const bad = await app.http.post('/api/boards').send({ title: '' }).expect(400);
  assert.equal(bad.body.error.code, 'bad_request');
  const malformed = await app.http
    .post('/api/boards')
    .set('Content-Type', 'application/json')
    .send('{"title":')
    .expect(400);
  assert.equal(malformed.body.error.message, 'Malformed JSON body');
  await app.http
    .post('/api/boards')
    .send({ title: 'x'.repeat(300_000) })
    .expect(413);
  const missing = await app.http.get('/api/nope').expect(404);
  assert.equal(missing.body.error.code, 'not_found');

  const { body } = await app.http.post('/api/boards').send({ title: 'B' }).expect(201);
  await app.http
    .post(`/api/boards/${body.board.id}/ops`)
    .set('Authorization', `Bearer ${body.editorToken}`)
    .send({ ops: [] })
    .expect(400);
});

test('board creation can be restricted with BOARD_CREATION_TOKEN', async (t) => {
  const app = await boot({ BOARD_CREATION_TOKEN: 'admin-secret-0123456789' });
  t.after(() => app.stop());
  await app.http.post('/api/boards').send({ title: 'B' }).expect(401);
  await app.http.post('/api/boards').set('X-Admin-Token', 'wrong').send({ title: 'B' }).expect(401);
  await app.http.post('/api/boards').set('X-Admin-Token', 'admin-secret-0123456789').send({ title: 'B' }).expect(201);
});

test('write endpoints are rate limited', async (t) => {
  const app = await boot({ RATE_LIMIT_WRITES_PER_MINUTE: '3' });
  t.after(() => app.stop());
  const { body } = await app.http.post('/api/boards').send({ title: 'B' }).expect(201);
  const send = (i) =>
    app.http
      .post(`/api/boards/${body.board.id}/ops`)
      .set('Authorization', `Bearer ${body.editorToken}`)
      .send({ ops: [{ opId: `o${i}`, type: 'column.create', id: `c${i}`, title: 'c' }] });
  for (let i = 0; i < 3; i++) await send(i).expect(200);
  const limited = await send(99).expect(429);
  assert.equal(limited.body.error.code, 'rate_limited');
});

test('CORS headers are only sent to configured origins', async (t) => {
  const app = await boot({ ALLOWED_ORIGINS: 'https://allowed.example' });
  t.after(() => app.stop());
  const ok = await app.http.get('/healthz').set('Origin', 'https://allowed.example');
  assert.equal(ok.headers['access-control-allow-origin'], undefined); // only /api
  const api = await app.http.options('/api/boards').set('Origin', 'https://allowed.example').expect(204);
  assert.equal(api.headers['access-control-allow-origin'], 'https://allowed.example');
  const other = await app.http.options('/api/boards').set('Origin', 'https://evil.example').expect(204);
  assert.equal(other.headers['access-control-allow-origin'], undefined);
});

test('readiness turns off while shutting down', async () => {
  const app = await boot();
  const stopping = app.stop();
  assert.equal(app.server.listening, true);
  await stopping;
  assert.equal(app.server.listening, false);
});
