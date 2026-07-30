/**
 * @fileoverview Database operations using sql.js with robust error handling.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { queryAll, queryOne, runSql, runTransaction } = require('./db-helper.js');

let db;
const dbPath = path.join(__dirname, 'kanban.db');

/**
 * Initializes the SQLite database.
 * Loads from disk if exists, otherwise creates tables.
 * @returns {Promise<void>}
 */
async function initDB() {
    try {
        const SQL = await initSqlJs();
        if (fs.existsSync(dbPath)) {
            const fileBuffer = fs.readFileSync(dbPath);
            db = new SQL.Database(fileBuffer);
        } else {
            db = new SQL.Database();
        }
        
        db.run(`
            CREATE TABLE IF NOT EXISTS cards (
                id TEXT PRIMARY KEY,
                boardId TEXT NOT NULL,
                columnId TEXT NOT NULL,
                title TEXT,
                description TEXT,
                assignees TEXT,
                labels TEXT,
                orderIndex REAL,
                isDeleted INTEGER DEFAULT 0,
                updatedAt INTEGER NOT NULL
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS columns (
                id TEXT PRIMARY KEY,
                boardId TEXT NOT NULL,
                title TEXT,
                orderIndex REAL,
                isDeleted INTEGER DEFAULT 0,
                updatedAt INTEGER NOT NULL
            )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_cards_board_deleted ON cards (boardId, isDeleted)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_columns_board_deleted ON columns (boardId, isDeleted)`);

        if (!fs.existsSync(dbPath)) {
            saveDB();
        }
    } catch (err) {
        console.error('Error during database initialization:', err);
        throw err;
    }
}

/**
 * Persists the database to disk.
 */
function saveDB() {
    try {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (err) {
        console.error('Error saving database to disk:', err);
        throw err;
    }
}

/**
 * Returns the entire state of the board.
 * @returns {Object} An object containing arrays of cards and columns.
 */
function getSnapshot() {
    try {
        const cards = queryAll(db, 'SELECT * FROM cards WHERE isDeleted = 0');
        const columns = queryAll(db, 'SELECT * FROM columns WHERE isDeleted = 0');
        
        return {
            cards: cards.map(c => ({
                ...c, 
                isDeleted: !!c.isDeleted,
                assignees: JSON.parse(c.assignees || '[]'),
                labels: JSON.parse(c.labels || '[]')
            })),
            columns: columns.map(c => ({
                ...c,
                isDeleted: !!c.isDeleted
            }))
        };
    } catch (err) {
        console.error('Error fetching snapshot:', err);
        throw new Error('Failed to retrieve board snapshot');
    }
}

/**
 * Processes incoming sync changes and applies them if they are newer.
 * @param {Array<Object>} changes - Array of change objects.
 * @returns {Object} Result object with appliedChanges and currentServerTime.
 */
function processSync(changes) {
    if (!Array.isArray(changes)) {
        throw new Error('Changes must be an array');
    }

    const appliedChanges = [];
    
    const insertCardSql = `
        INSERT INTO cards (id, boardId, columnId, title, description, assignees, labels, orderIndex, isDeleted, updatedAt)
        VALUES ($id, $boardId, $columnId, $title, $description, $assignees, $labels, $orderIndex, $isDeleted, $updatedAt)
        ON CONFLICT(id) DO UPDATE SET
            boardId = excluded.boardId,
            columnId = excluded.columnId,
            title = excluded.title,
            description = excluded.description,
            assignees = excluded.assignees,
            labels = excluded.labels,
            orderIndex = excluded.orderIndex,
            isDeleted = excluded.isDeleted,
            updatedAt = excluded.updatedAt
        WHERE excluded.updatedAt > cards.updatedAt
    `;

    const insertColumnSql = `
        INSERT INTO columns (id, boardId, title, orderIndex, isDeleted, updatedAt)
        VALUES ($id, $boardId, $title, $orderIndex, $isDeleted, $updatedAt)
        ON CONFLICT(id) DO UPDATE SET
            boardId = excluded.boardId,
            title = excluded.title,
            orderIndex = excluded.orderIndex,
            isDeleted = excluded.isDeleted,
            updatedAt = excluded.updatedAt
        WHERE excluded.updatedAt > columns.updatedAt
    `;

    try {
        runTransaction(db, () => {
            for (const change of changes) {
                const { type, payload } = change;
                
                if (type === 'CARD') {
                    const current = queryOne(db, 'SELECT updatedAt FROM cards WHERE id = $id', { $id: payload.id });
                    if (!current || payload.updatedAt > current.updatedAt) {
                        runSql(db, insertCardSql, {
                            $id: payload.id,
                            $boardId: payload.boardId,
                            $columnId: payload.columnId,
                            $title: payload.title || '',
                            $description: payload.description || '',
                            $assignees: JSON.stringify(payload.assignees || []),
                            $labels: JSON.stringify(payload.labels || []),
                            $orderIndex: payload.orderIndex || 0,
                            $isDeleted: payload.isDeleted ? 1 : 0,
                            $updatedAt: payload.updatedAt
                        });
                        appliedChanges.push(change);
                    }
                } else if (type === 'COLUMN') {
                    const current = queryOne(db, 'SELECT updatedAt FROM columns WHERE id = $id', { $id: payload.id });
                    if (!current || payload.updatedAt > current.updatedAt) {
                        runSql(db, insertColumnSql, {
                            $id: payload.id,
                            $boardId: payload.boardId,
                            $title: payload.title || '',
                            $orderIndex: payload.orderIndex || 0,
                            $isDeleted: payload.isDeleted ? 1 : 0,
                            $updatedAt: payload.updatedAt
                        });
                        appliedChanges.push(change);
                    }
                }
            }
        });

        if (appliedChanges.length > 0) {
            saveDB();
        }

        return { appliedChanges, currentServerTime: Date.now() };
    } catch (err) {
        console.error('Error processing sync:', err);
        throw new Error('Failed to process synchronization');
    }
}

module.exports = { initDB, getSnapshot, processSync };
