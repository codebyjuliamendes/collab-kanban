const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { queryAll, queryOne, runSql, runTransaction } = require('./db-helper.js');

let db;
const dbPath = path.join(__dirname, 'kanban.db');

async function initDB() {
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
            boardId TEXT,
            columnId TEXT,
            title TEXT,
            description TEXT,
            assignees TEXT,
            labels TEXT,
            orderIndex REAL,
            isDeleted INTEGER DEFAULT 0,
            updatedAt INTEGER
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS columns (
            id TEXT PRIMARY KEY,
            boardId TEXT,
            title TEXT,
            orderIndex REAL,
            isDeleted INTEGER DEFAULT 0,
            updatedAt INTEGER
        )
    `);

    if (!fs.existsSync(dbPath)) {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    }
}

function saveDB() {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
}

function getSnapshot() {
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
}

function processSync(changes) {
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
                        $title: payload.title,
                        $description: payload.description,
                        $assignees: JSON.stringify(payload.assignees || []),
                        $labels: JSON.stringify(payload.labels || []),
                        $orderIndex: payload.orderIndex,
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
                        $title: payload.title,
                        $orderIndex: payload.orderIndex,
                        $isDeleted: payload.isDeleted ? 1 : 0,
                        $updatedAt: payload.updatedAt
                    });
                    appliedChanges.push(change);
                }
            }
        }
    });

    if (appliedChanges.length > 0) saveDB();

    return { appliedChanges, currentServerTime: Date.now() };
}

module.exports = { initDB, getSnapshot, processSync };
