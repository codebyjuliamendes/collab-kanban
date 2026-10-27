'use strict';

/**
 * Operator CLI: issues an access token for an existing board.
 * Useful for boards migrated from the first version (which had no tokens).
 *
 *   npm run board:invite -- <boardId> [editor|viewer]
 *
 * Stop the server first: the database file is rewritten by whichever process
 * saves last.
 */
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { Database } = require('../src/db/database');
const { createBoardService } = require('../src/domain/board-service');

async function main() {
  const [boardId, role = 'editor'] = process.argv.slice(2);
  if (!boardId) {
    console.error('Usage: npm run board:invite -- <boardId> [editor|viewer]');
    process.exit(2);
  }
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: 'warn' });
  const db = await Database.open({ dataDir: config.DATA_DIR, debounceMs: 0, logger });
  try {
    const token = createBoardService({ db }).issueTokenAsOperator(boardId, role);
    db.saveNow();
    console.log(`Token (${role}) for board ${boardId}:\n${token}`);
    console.log(`Open: http://localhost:${config.PORT}/#board=${encodeURIComponent(boardId)}&key=${token}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
