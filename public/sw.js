const CACHE_NAME = 'kanban-cache-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/db.js',
    '/sync.js',
    '/dnd.js',
    '/app.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    if (event.request.url.includes('/api/')) return;
    
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request).then(fetchRes => {
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request.url, fetchRes.clone());
                    return fetchRes;
                });
            });
        }).catch(() => {
            // Return index.html for navigation requests offline
            if (event.request.mode === 'navigate') {
                return caches.match('/');
            }
        })
    );
});

self.addEventListener('sync', event => {
    if (event.tag === 'kanban-sync') {
        event.waitUntil(syncData());
    }
});

async function syncData() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('kanban-db', 1);
        request.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction('syncQueue', 'readonly');
            const store = tx.objectStore('syncQueue');
            const getAll = store.getAll();
            
            getAll.onsuccess = async () => {
                const queue = getAll.result;
                if (queue.length === 0) return resolve();
                
                try {
                    const res = await fetch('/api/sync', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(queue)
                    });
                    
                    if (res.ok) {
                        const delTx = db.transaction('syncQueue', 'readwrite');
                        delTx.objectStore('syncQueue').clear();
                        resolve();
                    } else {
                        reject('Sync failed');
                    }
                } catch (err) {
                    reject(err);
                }
            };
            getAll.onerror = () => reject('IDB Error');
        };
        request.onerror = () => reject('IDB Error');
    });
}
