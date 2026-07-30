const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { initDB, processSync, getSnapshot } = require('./database.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

(async () => {
    await initDB();
})();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/snapshot', (req, res) => {
    res.json(getSnapshot());
});

app.post('/api/sync', (req, res) => {
    const changes = req.body;
    const result = processSync(changes);
    
    if (result.appliedChanges.length > 0) {
        broadcast(JSON.stringify({
            type: 'SYNC',
            changes: result.appliedChanges
        }));
    }
    
    res.json(result);
});

const clients = new Map();

function broadcast(message, senderWs) {
    wss.clients.forEach((client) => {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    ws.id = require('crypto').randomUUID();
    clients.set(ws.id, { presence: null });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'SYNC') {
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
        } catch (e) {
            console.error('WebSocket message error:', e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws.id);
        broadcastPresence();
    });
});

function broadcastPresence() {
    const presenceData = Array.from(clients.entries())
        .filter(([_, state]) => state.presence && state.presence.boardId)
        .map(([id, state]) => ({ id, ...state.presence }));

    broadcast(JSON.stringify({
        type: 'PRESENCE_UPDATE',
        users: presenceData
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
