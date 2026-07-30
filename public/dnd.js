class DragDropEngine {
    constructor(boardEl) {
        this.board = boardEl;
        this.draggingEl = null;
        this.cloneEl = null;
        this.startX = 0;
        this.startY = 0;
        this.currentX = 0;
        this.currentY = 0;
        this.placeholder = null;
        
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);

        this.board.addEventListener('pointerdown', this.onPointerDown);
    }

    onPointerDown(e) {
        if (e.button !== 0) return; // Only left click
        
        const card = e.target.closest('.card');
        const header = e.target.closest('.column-header');
        
        if (!card && !header) return;
        
        // Prevent default text selection
        e.preventDefault();

        // Target is card for now
        if (card) {
            this.startDrag(card, e);
        }
    }

    startDrag(el, e) {
        this.draggingEl = el;
        this.draggingType = 'card';
        
        const rect = el.getBoundingClientRect();
        this.startX = e.clientX;
        this.startY = e.clientY;
        this.offsetX = e.clientX - rect.left;
        this.offsetY = e.clientY - rect.top;

        // Create placeholder
        this.placeholder = document.createElement('div');
        this.placeholder.className = 'drop-indicator';
        this.placeholder.style.width = `${rect.width}px`;
        
        // Create Clone for visual dragging
        this.cloneEl = el.cloneNode(true);
        this.cloneEl.classList.add('is-dragging');
        this.cloneEl.style.position = 'fixed';
        this.cloneEl.style.top = '0';
        this.cloneEl.style.left = '0';
        this.cloneEl.style.width = `${rect.width}px`;
        this.cloneEl.style.height = `${rect.height}px`;
        this.cloneEl.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) rotate(2deg)`;
        this.cloneEl.style.pointerEvents = 'none';
        this.cloneEl.style.willChange = 'transform';
        
        document.body.appendChild(this.cloneEl);
        
        el.style.opacity = '0.3';
        el.parentNode.insertBefore(this.placeholder, el.nextSibling);

        document.addEventListener('pointermove', this.onPointerMove, { passive: false });
        document.addEventListener('pointerup', this.onPointerUp);
    }

    onPointerMove(e) {
        if (!this.draggingEl) return;
        
        e.preventDefault();
        
        const x = e.clientX - this.offsetX;
        const y = e.clientY - this.offsetY;
        
        // Use transform translate3d for GPU acceleration
        requestAnimationFrame(() => {
            if (this.cloneEl) {
                this.cloneEl.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(2deg)`;
            }
        });

        // Find potential drop target
        const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);
        const column = elementsUnder.find(el => el.classList.contains('column'));
        
        if (column) {
            const list = column.querySelector('.card-list');
            const cards = Array.from(list.querySelectorAll('.card:not(.is-dragging)'));
            
            let inserted = false;
            for (let card of cards) {
                const rect = card.getBoundingClientRect();
                if (e.clientY < rect.top + rect.height / 2) {
                    list.insertBefore(this.placeholder, card);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) {
                list.appendChild(this.placeholder);
            }
        }
    }

    onPointerUp(e) {
        if (!this.draggingEl) return;
        
        document.removeEventListener('pointermove', this.onPointerMove);
        document.removeEventListener('pointerup', this.onPointerUp);

        // Move actual element to placeholder
        if (this.placeholder && this.placeholder.parentNode) {
            const list = this.placeholder.parentNode;
            list.insertBefore(this.draggingEl, this.placeholder);
            
            // Trigger move event
            const columnId = list.closest('.column').dataset.id;
            const cardId = this.draggingEl.dataset.id;
            
            // Calculate new order index
            const cards = Array.from(list.querySelectorAll('.card'));
            const idx = cards.indexOf(this.draggingEl);
            let prevOrder = idx > 0 ? parseFloat(cards[idx - 1].dataset.order) : 0;
            let nextOrder = idx < cards.length - 1 ? parseFloat(cards[idx + 1].dataset.order) : prevOrder + 2;
            const newOrder = (prevOrder + nextOrder) / 2;
            
            this.draggingEl.dataset.order = newOrder;
            
            if (window.app && window.app.onCardMoved) {
                window.app.onCardMoved(cardId, columnId, newOrder);
            }
        }

        // Cleanup
        this.draggingEl.style.opacity = '';
        if (this.cloneEl) this.cloneEl.remove();
        if (this.placeholder) this.placeholder.remove();
        
        this.draggingEl = null;
        this.cloneEl = null;
        this.placeholder = null;
    }
}
