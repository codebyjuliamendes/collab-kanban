class SyncManager {
    constructor() {
        this.ws = null;
        this.isOnline = navigator.onLine;
        this.boardId = 'default-board';
        this.userId = this.generateId();
        this.statusEl = document.getElementById('connection-status');
        
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());
        
        this.updateStatus();
    }

    generateId() {
        return Math.random().toString(36).substring(2, 15);
    }

    async init() {
        await window.db.init();
        this.connect();
        
        if (this.isOnline) {
            await this.fetchSnapshot();
            await this.syncQueue();
        }
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}`);
        
        this.ws.onopen = () => {
            this.updateStatus();
            this.sendPresence();
        };
        
        this.ws.onclose = () => {
            setTimeout(() => this.connect(), 3000);
        };
        
        this.ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'SYNC') {
                await this.applyChanges(data.changes);
                window.app.render(); // Re-render whole board for simplicity
            } else if (data.type === 'PRESENCE_UPDATE') {
                window.app.updatePresence(data.users);
            }
        };
    }

    async fetchSnapshot() {
        try {
            this.setStatus('syncing', 'Syncing');
            const res = await fetch('/api/snapshot');
            const data = await res.json();
            
            // Overwrite local db completely on initial load for simplicity
            await window.db.clear('cards');
            await window.db.clear('columns');
            
            for (const c of data.cards) {
                await window.db.put('cards', c);
            }
            for (const c of data.columns) {
                await window.db.put('columns', c);
            }
            this.updateStatus();
        } catch (e) {
            console.error('Snapshot failed', e);
        }
    }

    async syncQueue() {
        const queue = await window.db.getSyncQueue();
        if (queue.length === 0) return;
        
        try {
            const res = await fetch('/api/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queue)
            });
            if (res.ok) {
                await window.db.clearSyncQueue();
            }
        } catch (e) {
            console.error('Sync queue failed', e);
        }
    }

    async mutate(type, payload) {
        payload.updatedAt = Date.now();
        
        const change = { type, payload };
        
        // Apply locally
        const storeName = type === 'CARD' ? 'cards' : 'columns';
        await window.db.put(storeName, payload);
        
        // Queue for sync
        await window.db.addToSyncQueue(change);
        
        // Try to send immediately if websocket open
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'SYNC', changes: [change] }));
            // We clear queue if optimistic send works, or let sync routine handle it
            await window.db.clearSyncQueue();
        }
    }

    async applyChanges(changes) {
        for (const change of changes) {
            const storeName = change.type === 'CARD' ? 'cards' : 'columns';
            const local = await window.db.getAll(storeName).then(items => items.find(i => i.id === change.payload.id));
            
            if (!local || change.payload.updatedAt > local.updatedAt) {
                await window.db.put(storeName, change.payload);
            }
        }
    }

    sendPresence() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'PRESENCE',
                presence: {
                    boardId: this.boardId,
                    userId: this.userId,
                    color: '#' + Math.floor(Math.random()*16777215).toString(16)
                }
            }));
        }
    }

    handleOnline() {
        this.isOnline = true;
        this.updateStatus();
        this.syncQueue();
        window.app.showToast('Back online! Syncing...');
    }

    handleOffline() {
        this.isOnline = false;
        this.updateStatus();
        window.app.showToast('Offline mode active');
    }

    setStatus(className, text) {
        this.statusEl.className = `status-badge ${className}`;
        this.statusEl.textContent = text;
    }

    updateStatus() {
        if (!this.isOnline) {
            this.setStatus('offline', 'Offline');
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.setStatus('online', 'Online');
        } else {
            this.setStatus('syncing', 'Connecting');
        }
    }
}

window.sync = new SyncManager();
