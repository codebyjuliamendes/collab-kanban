'use strict';

const pino = require('pino');
const { Database } = require('../src/db/database');
const { createBoardService } = require('../src/domain/board-service');

const silentLogger = pino({ level: 'silent' });

async function createTestService({ clock } = {}) {
  const db = await Database.open({ dataDir: null, logger: silentLogger });
  const service = createBoardService({ db, clock });
  return { db, service };
}

let counter = 0;
const nextId = (prefix) => `${prefix}_${++counter}`;

module.exports = { silentLogger, createTestService, nextId };
