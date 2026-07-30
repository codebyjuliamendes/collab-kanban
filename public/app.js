class App {
    constructor() {
        this.boardEl = document.getElementById('board');
        this.toastContainer = document.getElementById('toast-container');
        this.presenceContainer = document.getElementById('presence-avatars');
        this.addColumnBtn = document.getElementById('add-column-btn');
        this.dnd = new DragDropEngine(this.boardEl);
        
        this.addColumnBtn.addEventListener('click', () => this.addColumn());
        
        this.init();
    }

    async init() {
        // Simulated load state as requested
        await new Promise(r => setTimeout(r, 1500));
        await window.sync.init();
        await this.render();
    }

    generateId() {
        return Math.random().toString(36).substring(2, 15);
    }

    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        const iconName = type === 'success' ? 'check-circle' : (type === 'error' ? 'alert-circle' : 'info');
        const iconColor = type === 'success' ? 'text-emerald-400' : (type === 'error' ? 'text-rose-400' : 'text-blue-400');
        
        toast.className = 'toast bg-slate-800/90 backdrop-blur border border-white/10 p-4 rounded-xl shadow-2xl transition-all duration-300 translate-x-0 flex items-center gap-3 w-80 transform opacity-0 translate-y-4';
        toast.innerHTML = `
            <div class="flex-shrink-0 ${iconColor}">
                <i data-lucide="${iconName}" class="w-5 h-5"></i>
            </div>
            <div class="flex-1 text-slate-200 font-medium text-sm">${message}</div>
        `;
        this.toastContainer.appendChild(toast);
        
        if (window.lucide) window.lucide.createIcons({ root: toast });
        
        // Animate in
        requestAnimationFrame(() => {
            toast.classList.remove('opacity-0', 'translate-y-4');
        });
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    async addColumn() {
        const columns = await window.db.getAll('columns');
        const maxOrder = columns.length > 0 ? Math.max(...columns.map(c => c.orderIndex)) : 0;
        
        const column = {
            id: 'col_' + this.generateId(),
            boardId: window.sync.boardId,
            title: 'New Column',
            orderIndex: maxOrder + 10,
            isDeleted: false
        };
        
        await window.sync.mutate('COLUMN', column);
        await this.render();
    }

    async addCard(columnId) {
        const cards = await window.db.getAll('cards');
        const colCards = cards.filter(c => c.columnId === columnId);
        const maxOrder = colCards.length > 0 ? Math.max(...colCards.map(c => c.orderIndex)) : 0;
        
        const card = {
            id: 'card_' + this.generateId(),
            boardId: window.sync.boardId,
            columnId: columnId,
            title: 'New Task',
            description: '',
            assignees: [],
            labels: [],
            orderIndex: maxOrder + 10,
            isDeleted: false
        };
        
        await window.sync.mutate('CARD', card);
        await this.render();
    }

    async onCardMoved(cardId, newColumnId, newOrder) {
        const cards = await window.db.getAll('cards');
        const card = cards.find(c => c.id === cardId);
        if (card) {
            card.columnId = newColumnId;
            card.orderIndex = newOrder;
            await window.sync.mutate('CARD', card);
        }
    }

    async updateColumnTitle(colId, newTitle) {
        const columns = await window.db.getAll('columns');
        const col = columns.find(c => c.id === colId);
        if (col && col.title !== newTitle) {
            col.title = newTitle;
            await window.sync.mutate('COLUMN', col);
        }
    }

    async updateCardTitle(cardId, newTitle) {
        const cards = await window.db.getAll('cards');
        const card = cards.find(c => c.id === cardId);
        if (card && card.title !== newTitle) {
            card.title = newTitle;
            await window.sync.mutate('CARD', card);
        }
    }

    async render() {
        const columns = await window.db.getAll('columns');
        const cards = await window.db.getAll('cards');
        
        columns.sort((a, b) => a.orderIndex - b.orderIndex);
        
        this.boardEl.innerHTML = '';
        
        const colTemplate = document.getElementById('column-template');
        const cardTemplate = document.getElementById('card-template');

        for (const col of columns) {
            if (col.isDeleted) continue;
            
            const colNode = colTemplate.content.cloneNode(true);
            const colEl = colNode.querySelector('.column');
            colEl.dataset.id = col.id;
            
            const titleInput = colNode.querySelector('.column-title');
            titleInput.value = col.title;
            titleInput.addEventListener('change', (e) => this.updateColumnTitle(col.id, e.target.value));
            
            const addBtn = colNode.querySelector('.add-card-btn');
            addBtn.addEventListener('click', () => this.addCard(col.id));
            
            const listEl = colNode.querySelector('.card-list');
            
            const colCards = cards.filter(c => c.columnId === col.id && !c.isDeleted);
            colCards.sort((a, b) => a.orderIndex - b.orderIndex);
            
            for (const card of colCards) {
                const cardNode = cardTemplate.content.cloneNode(true);
                const cardEl = cardNode.querySelector('.card');
                cardEl.dataset.id = card.id;
                cardEl.dataset.order = card.orderIndex;
                
                const titleEl = cardNode.querySelector('.card-title');
                titleEl.textContent = card.title;
                titleEl.contentEditable = true;
                titleEl.addEventListener('blur', (e) => this.updateCardTitle(card.id, e.target.textContent));
                
                listEl.appendChild(cardNode);
            }
            
            this.boardEl.appendChild(colNode);
        }
        
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    updatePresence(users) {
        this.presenceContainer.innerHTML = '';
        users.forEach(user => {
            if (user.userId !== window.sync.userId) {
                const avatar = document.createElement('div');
                avatar.className = 'avatar w-8 h-8 rounded-full border-2 border-slate-900 flex items-center justify-center text-xs font-bold text-white shadow-sm ring-1 ring-white/10 relative z-10';
                avatar.style.backgroundColor = user.color;
                avatar.textContent = user.userId.substring(0, 2).toUpperCase();
                avatar.title = `User ${user.userId}`;
                this.presenceContainer.appendChild(avatar);
            }
        });
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
