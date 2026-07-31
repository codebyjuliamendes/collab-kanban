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
        
        // Yjs Setup for WebRTC fallback
        if (typeof Y !== 'undefined' && typeof WebrtcProvider !== 'undefined') {
            this.ydoc = new Y.Doc();
            this.webrtcProvider = new WebrtcProvider('collab-kanban-room', this.ydoc, { signaling: ['wss://signaling.yjs.dev'] });
            this.yMap = this.ydoc.getMap('sync-state');
            
            this.yMap.observe(event => {
                // simple observe to trigger re-sync from indexdb on changes if offline
                if (!this.isOnline) {
                    this.fetchSnapshot(); // or trigger UI update
                }
            });
        }

        this.connect();
        
        if (this.isOnline) {
            await this.fetchSnapshot();
            await this.syncQueue();
        }

        // Register Service Worker for Background Sync if supported
        if ('serviceWorker' in navigator && 'SyncManager' in window) {
            navigator.serviceWorker.ready.then(swRegistration => {
                return swRegistration.sync.register('kanban-sync');
            }).catch(err => console.error('Background Sync registration failed:', err));
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

        if (this.yMap) {
            this.yMap.set(payload.id, payload.updatedAt);
        }
        
        // Try to send immediately if websocket open
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'SYNC', changes: [change] }));
            // We clear queue if optimistic send works, or let sync routine handle it
            await window.db.clearSyncQueue();
        } else if ('serviceWorker' in navigator && 'SyncManager' in window) {
            navigator.serviceWorker.ready.then(swRegistration => {
                return swRegistration.sync.register('kanban-sync');
            });
        }
    }

    async applyChanges(changes) {
        for (const change of changes) {
            const storeName = change.type === 'CARD' ? 'cards' : 'columns';
            const local = await window.db.getAll(storeName).then(items => items.find(i => i.id === change.payload.id));
            
            // Mathematical CRDT LWW-Register Check
            const isNewer = !local || change.payload.updatedAt > local.updatedAt;
            const isTieBreaker = local && change.payload.updatedAt === local.updatedAt && change.payload.id > local.id;

            if (isNewer || isTieBreaker) {
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
        this.statusEl.className = `status-badge px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${className}`;
        this.statusEl.textContent = text;
    }

    updateStatus() {
        if (!this.isOnline) {
            this.setStatus('bg-red-500/20 text-red-400 border border-red-500/30', 'Offline');
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.setStatus('bg-emerald-500/20 text-emerald-400 border border-emerald-500/30', 'Online');
        } else {
            this.setStatus('bg-amber-500/20 text-amber-400 border border-amber-500/30', 'Connecting');
        }
    }
}

window.sync = new SyncManager();
