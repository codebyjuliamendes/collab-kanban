# Collab Kanban

[![CI](https://github.com/codebyjuliamendes/collab-kanban/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/codebyjuliamendes/collab-kanban/actions/workflows/ci-cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A real-time collaborative Kanban board. Several people edit the same board at once, see each other's changes live, and keep working while offline. The changes are sent when the connection comes back.

Stack: Node.js 22, Express, `ws` WebSockets, SQLite (`sql.js`), and a vanilla JavaScript frontend with no build step.

## Features

- **Boards with access links.** Each board has its own secret links: _can edit_ and _can view_. Editors can create new links and revoke old ones. People whose link was revoked are disconnected right away.
- **Real-time sync.** Changes go to everyone on the board over a WebSocket. Every change has a sequence number per board. A client that misses a change notices the gap and reloads the board state.
- **Consistent ordering.** Cards and columns are ordered by fractional ranks that the server computes. When two people drop cards into the same slot at the same time, both get distinct, stable positions, and every client ends up with the same order.
- **No silent overwrites.** Edits carry the version the user started from. If someone else saved first, the edit is rejected as a conflict. The editor then reopens with your text and the other person's saved version, so you can decide what to keep.
- **Offline first.** Edits show up immediately and wait in a local queue until the server confirms them. The queue survives reloads. Every operation has an id, so resending it after a reconnect never applies it twice.
- **Accessible drag and drop.** You can drag with the mouse, pen or touch (touch uses the grip handle). Keyboard users focus a card's grip and press <kbd>Space</kbd> to pick it up, the arrow keys to move it (<kbd>Home</kbd>/<kbd>End</kbd> jump to the top or bottom), <kbd>Space</kbd> to drop and <kbd>Escape</kbd> to cancel. Every step is announced to screen readers. Columns move with their arrow buttons.
- **Presence.** Shows who else has the board open.
- Light and dark themes (system preference or manual toggle). The layout is responsive down to 390 px.
- Swagger UI at `/api-docs`, served from the app itself.

## Quick start

```bash
npm ci
npm start            # http://localhost:3002
```

Open the app, create a board, then use **Share** to copy an edit link or a view link. Open a link in another browser to see the changes sync live.

With Docker:

```bash
docker compose up --build   # http://localhost:3002, data in the "kanban-data" volume
```

## Configuration

Every variable is optional. Invalid values stop the server at boot with a clear message. See [`.env.example`](.env.example).

| Variable                       | Default            | Description                                                                                                                                                         |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` / `HOST`                | `3002` / `0.0.0.0` | Listen address.                                                                                                                                                     |
| `DATA_DIR`                     | `./data`           | Folder for `kanban.db`. It must be persistent: a volume in Docker, a PVC in Kubernetes.                                                                             |
| `LOG_LEVEL`                    | `info`             | Level for the structured JSON logs (pino).                                                                                                                          |
| `BOARD_CREATION_TOKEN`         | _(empty)_          | If set (16+ characters), creating a board requires the header `X-Admin-Token: <value>`. If empty, anyone who can reach the server can create boards (rate limited). |
| `ALLOWED_ORIGINS`              | _(empty)_          | Extra browser origins allowed for CORS and WebSocket, comma separated. Same origin always works.                                                                    |
| `TRUST_PROXY`                  | `0`                | Number of reverse proxies in front of the app, used to read client IPs for rate limiting.                                                                           |
| `RATE_LIMIT_WRITES_PER_MINUTE` | `120`              | REST write requests per IP per minute.                                                                                                                              |
| `PERSIST_DEBOUNCE_MS`          | `250`              | Delay before changes are written to disk.                                                                                                                           |
| `ENABLE_API_DOCS`              | `true`             | Serve Swagger UI at `/api-docs`.                                                                                                                                    |

## Scripts

| Command                               | What it does                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm start`                           | Start the server.                                                                  |
| `npm run dev`                         | Start with auto-restart on file changes.                                           |
| `npm test`                            | Unit and integration tests (`node:test`).                                          |
| `npm run lint`                        | ESLint.                                                                            |
| `npm run format` / `format:check`     | Prettier.                                                                          |
| `npm run check`                       | Lint, format check and tests (the same as CI).                                     |
| `npm run board:invite -- <id> [role]` | Issue an access link for an existing board (operator tool; stop the server first). |

## Architecture

```
server.js                 entry point (kept for `node server.js`)
src/
  config.js               env validation (zod), fails fast at boot
  logger.js               structured logs, secrets redacted
  server.js               wiring, health/readiness, graceful shutdown
  http/app.js             REST API, security headers/CSP, rate limits, static files
  ws/hub.js               WebSocket rooms per board, auth handshake, heartbeats
  domain/board-service.js use cases: boards, tokens, snapshot, operations
  domain/ops.js           operation schemas and input limits
  domain/tokens.js        token generation and hashing
  db/database.js          sql.js database, atomic and debounced persistence
  db/migrations.js        schema migrations (including the v1 import)
  db/repository.js        SQL queries
shared/rank.js            fractional ranks, shared by server and browser
public/                   frontend (ES modules, no build step)
  js/state.js             confirmed state, pending operations, optimistic view
  js/sync.js              WebSocket session, offline queue, reconnects
  js/dnd.js               pointer and keyboard drag and drop
  js/app.js               rendering and UI
```

### How a change travels

1. The browser turns a user action into an **operation**, for example `{ opId, type: "card.move", id, columnId, afterId, beforeId }`. It applies the operation to its local view at once and stores it in the pending queue.
2. Pending operations go over the WebSocket: `{ type: "ops", ops: [...] }`.
3. The server checks the token, validates the operation and applies it in a SQLite transaction. It assigns the next board `seq` and records the `opId` for idempotency.
4. Every client on the board receives `{ type: "event", seq, opId, changes }`, the sender included. The sender then gets an `ack` with one result per operation: `applied`, `noop`, `conflict` (with the current entity) or `rejected`.
5. Each client applies events strictly in `seq` order. On a gap it asks for a `resync`. What the user sees is always the confirmed state with the still-pending operations replayed on top.

### Decisions and trade-offs

- **Server-computed fractional ranks instead of float `orderIndex`.** The old float midpoint lost precision after about 50 moves into the same spot. It also let two clients compute the same value. Ranks are base-62 strings that always have room between them. The server computes them from its own state, so concurrent moves cannot collide. Clients send their intent (`afterId`/`beforeId`), not a number. If ranks grow too long, the server rebalances the list in the same event.
- **Optimistic versioning instead of client-timestamp last-write-wins.** Client clocks are not trustworthy. A client with a clock set in the future could override everyone, and a client could even send a timestamp by hand. Content edits (title, description, delete) now carry `baseVersion`. A mismatch is reported as a conflict instead of overwriting someone's work. Moves don't change the version, so dragging a card never conflicts with someone editing its text.
- **Secret links instead of user accounts.** This keeps the tool lightweight. Tokens are 256-bit random values; only their SHA-256 hash is stored. Tokens travel in the `Authorization` header or the first WebSocket message, never in a URL the server logs. In the browser the key is read from the URL fragment, stored locally, and then removed from the address bar.
- **SQLite through `sql.js` (in memory, saved to disk).** It has no native dependencies. Writes are serialised by Node's event loop, and the file is saved atomically: written to a temp file, fsynced, then renamed.
- **No frontend build.** Plain ES modules and hand-written CSS. This allows a strict Content Security Policy (`script-src 'self'`, no inline code, no CDNs) that protects against XSS. On top of that, all user text is rendered with `textContent`.

## Security

- Per-board authorization on every REST call and WebSocket session. Viewers are read-only on the server, not just in the UI. Ids from other boards cannot be read, changed or reused.
- Input validation with size limits on titles, descriptions, batches, request bodies (256 KiB) and WebSocket messages (256 KiB). There are also limits per board: 100 columns and 5000 cards.
- Strict CSP and security headers (helmet). WebSocket connections from other origins are refused unless they are in `ALLOWED_ORIGINS`.
- Rate limits: REST writes per IP, board creation per IP (30 per hour), and operations per WebSocket connection.
- Errors are returned in one consistent shape (`{ error: { code, message } }`). Internal details are never exposed.

## Tests

```bash
npm test
```

- `test/rank.test.js`: rank generation, ordering under thousands of random inserts, rebalancing.
- `test/board-service.test.js`: authorization, conflicts, idempotency, concurrent drops into the same slot, cross-board isolation, cascading deletes, limits.
- `test/database.test.js`: persistence across restarts, transaction rollback, migration of a database from the first version.
- `test/http.test.js`: REST API, permissions, CSP and headers, validation, rate limiting, CORS.
- `test/ws.test.js`: real-time events in order, viewer write refusal, bad tokens, cross-origin refusal, revocation, resync, shutdown.
- `test/client-state.test.js`: the browser state module (optimistic view, gap detection), plus two simulated clients converging on the server order.

CI (`.github/workflows/ci-cd.yml`) runs lint, format check, tests and `npm audit`. It also builds the Docker image and smoke tests it: health, a board, an operation, unauthorized access, and data surviving a restart.

## Deployment

- **Docker.** The image is multi-stage and runs as a non-root user, with a `HEALTHCHECK`. The data lives in `/data`; mount a volume there. The container works with a read-only root filesystem.
- **Kubernetes** (`k8s/`): Deployment, PVC, Service and Ingress, with `/healthz` (liveness) and `/readyz` (readiness) probes, a restricted security context and WebSocket-friendly ingress timeouts. Replace `image:` with your registry image. You can also create a `collab-kanban` secret with the key `board-creation-token` to restrict board creation.
- **Graceful shutdown.** On `SIGTERM` the server stops accepting connections and closes WebSockets with code 1001, so clients reconnect. It then writes the database to disk.

### Upgrading from the first version

On the first start, `kanban.db` from the project root is copied into `DATA_DIR` and migrated. Columns and cards keep their order. The first version had no access control, so the migrated board (`default-board`) has no links yet. Create one with:

```bash
npm run board:invite -- default-board editor
```

## Limitations

- **One instance only.** The state lives in one SQLite file and the real-time fan-out happens in that process. Running more replicas would split users into groups that never see each other's changes. That is why the Kubernetes manifest uses `replicas: 1` with `Recreate`. Scaling out would need a shared database and pub/sub (for example PostgreSQL with `LISTEN/NOTIFY` or Redis).
- **Durability window.** Changes are written to disk at most `PERSIST_DEBOUNCE_MS` after they happen, and immediately on a graceful shutdown. A hard crash can lose the last fraction of a second. The whole database is rewritten on each save, which is fine for small and medium boards.
- **Links are bearer secrets.** Anyone holding a link has that access until it is revoked. There are no individual accounts or audit trail per person.
- **Offline edits are stored in `localStorage`** in that browser. Clearing site data discards edits that were not sent yet.
- Conflicting edits are resolved by asking the user to save again; there is no character-level merge of text.

## License

[MIT](LICENSE)
