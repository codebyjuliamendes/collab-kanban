/**
 * @fileoverview Main server entrypoint for the Kanban backend.
 * Provides WebSocket sync and HTTP endpoints with rigorous error handling.
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { initDB, processSync, getSnapshot } = require('./database.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Validates the structure of a sync change payload.
 * @param {Object} change - The change object to validate.
 * @throws {Error} If validation fails.
 */
function validateChange(change) {
    if (!change || typeof change !== 'object') throw new Error('Invalid change object');
    if (!['CARD', 'COLUMN'].includes(change.type)) throw new Error('Invalid change type');
    if (!change.payload || typeof change.payload !== 'object') throw new Error('Invalid payload');
    if (!change.payload.id || typeof change.payload.id !== 'string') throw new Error('Invalid payload ID');
}

/**
 * Initializes the backend server.
 */
async function bootstrap() {
    try {
        await initDB();
        console.log('Database initialized successfully.');
    } catch (err) {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    }
}
bootstrap();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Routes ---

app.get('/api/snapshot', (req, res, next) => {
    try {
        const snapshot = getSnapshot();
        res.status(200).json(snapshot);
    } catch (err) {
        next(err);
    }
});

app.post('/api/sync', (req, res, next) => {
    try {
        const changes = req.body;
        if (!Array.isArray(changes)) {
            throw new Error('Changes must be an array');
        }
        
        changes.forEach(validateChange);
        
        const result = processSync(changes);
        if (result.appliedChanges.length > 0) {
            broadcast(JSON.stringify({
                type: 'SYNC',
                changes: result.appliedChanges
            }));
        }
        
        res.status(200).json(result);
    } catch (err) {
        next(err);
    }
});

// --- Error Middleware ---
app.use((err, req, res, next) => {
    console.error(`[Error] ${err.message}`, err.stack);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error'
    });
});

// --- WebSocket Handling ---

/** @type {Map<string, Object>} */
const clients = new Map();

/**
 * Broadcasts a message to all connected clients except the sender.
 * @param {string} message - JSON stringified message.
 * @param {WebSocket} [senderWs] - The sender to exclude.
 */
function broadcast(message, senderWs) {
    for (const client of wss.clients) {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (err) {
                console.error('Error sending message to client:', err);
            }
        }
    }
}

/**
 * Broadcasts the current presence state of all users.
 */
function broadcastPresence() {
    const presenceData = Array.from(clients.entries())
        .filter(([_, state]) => state.presence && state.presence.boardId)
        .map(([id, state]) => ({ id, ...state.presence }));

    broadcast(JSON.stringify({
        type: 'PRESENCE_UPDATE',
        users: presenceData
    }));
}

wss.on('connection', (ws) => {
    ws.id = require('crypto').randomUUID();
    clients.set(ws.id, { presence: null });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'SYNC') {
                if (!Array.isArray(data.changes)) throw new Error('SYNC requires an array of changes');
                data.changes.forEach(validateChange);
                
                const result = processSync(data.changes);
                if (result.appliedChanges.length > 0) {
                    broadcast(JSON.stringify({
                        type: 'SYNC',
                        changes: result.appliedChanges
                    }), ws);
                }
            } else if (data.type === 'PRESENCE') {
                clients.set(ws.id, { presence: data.presence });
                broadcastPresence();
            }
        } catch (err) {
            console.error('WebSocket message processing error:', err.message);
            ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws.id);
        broadcastPresence();
    });
    
    ws.on('error', (err) => {
        console.error(`WebSocket error for client ${ws.id}:`, err);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
