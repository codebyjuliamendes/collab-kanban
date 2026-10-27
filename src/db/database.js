'use strict';

const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { migrate } = require('./migrations');

/**
 * SQLite (sql.js, in memory) with debounced, atomic snapshots to disk.
 *
 * Every write goes through `transaction()`; after it commits a save is
 * scheduled. The file is written to a temporary path, fsynced and renamed,
 * so a crash during a save never leaves a half-written database behind.
 */
class Database {
  /**
   * @param {import('sql.js').Database} sqlDb
   * @param {{ filePath: string|null, debounceMs: number, logger: import('pino').Logger }} options
   */
  constructor(sqlDb, { filePath, debounceMs, logger }) {
    this.sql = sqlDb;
    this.filePath = filePath;
    this.debounceMs = debounceMs;
    this.logger = logger;
    this.saveTimer = null;
    this.dirty = false;
    this.inTransaction = false;
  }

  /**
   * Opens (or creates) the database. `dataDir` null keeps it in memory only.
   * @param {{ dataDir: string|null, debounceMs?: number, logger: import('pino').Logger }} options
   */
  static async open({ dataDir, debounceMs = 250, logger }) {
    const SQL = await initSqlJs();
    let filePath = null;
    let sqlDb;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      filePath = path.join(dataDir, 'kanban.db');
      sqlDb = fs.existsSync(filePath) ? new SQL.Database(fs.readFileSync(filePath)) : new SQL.Database();
    } else {
      sqlDb = new SQL.Database();
    }
    const database = new Database(sqlDb, { filePath, debounceMs, logger });
    const applied = migrate(database);
    if (applied.length > 0) {
      logger.info({ migrations: applied }, 'database migrated');
      database.saveNow();
    }
    return database;
  }

  /** @returns {object[]} */
  all(sql, params = {}) {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  /** @returns {object|null} */
  get(sql, params = {}) {
    return this.all(sql, params)[0] || null;
  }

  /** @returns {number} rows modified */
  run(sql, params = {}) {
    this.sql.run(sql, params);
    return this.sql.getRowsModified();
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.sql.run('BEGIN');
    this.inTransaction = true;
    try {
      const result = fn();
      this.sql.run('COMMIT');
      this.inTransaction = false;
      this.markDirty();
      return result;
    } catch (err) {
      this.inTransaction = false;
      try {
        this.sql.run('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw err;
    }
  }

  markDirty() {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, this.debounceMs);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.filePath) return;
    try {
      const data = Buffer.from(this.sql.export());
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
    } catch (err) {
      // Keep serving from memory; the next write retries the save.
      this.logger.error({ err }, 'failed to persist database');
    }
  }

  isHealthy() {
    try {
      this.get('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  close() {
    if (this.dirty) this.saveNow();
    this.sql.close();
  }
}

module.exports = { Database };
