/**
 * Drag and drop for cards, with pointer (mouse, pen, touch via the grip
 * handle) and a full keyboard alternative:
 *
 *   focus the grip, Space/Enter to pick up, arrows to move (Home/End jump to
 *   top/bottom of the column), Space/Enter to drop, Escape to cancel.
 *
 * Every step is announced through a live region. The engine only moves DOM
 * nodes as a preview; the final position is reported through `onDrop` and the
 * app re-renders from state.
 */

const DRAG_THRESHOLD_PX = 5;
const EDGE_SCROLL_PX = 48;
const NON_DRAG_TARGETS = 'input, textarea, select, a, .card-actions button';

const cardsIn = (list, except) =>
  [...list.querySelectorAll(':scope > .card')].filter((el) => el !== except && !el.classList.contains('is-ghost'));

export class DragDrop {
  /**
   * @param {HTMLElement} board container with `.card-list` elements
   * @param {HTMLElement} scroller horizontally scrolling ancestor
   * @param {{
   *   canDrag: () => boolean,
   *   onDrop: (drop: { cardId: string, columnId: string, index: number }) => void,
   *   onCancel: () => void,
   *   announce: (message: string) => void,
   *   describe: (cardEl: HTMLElement) => { title: string, column: string, position: number, total: number },
   * }} options
   */
  constructor(board, scroller, options) {
    this.board = board;
    this.scroller = scroller;
    this.options = options;
    this.pointer = null; // { cardEl, pointerId, startX, startY, dragging, ghost, placeholder, offsetX, offsetY }
    this.lifted = null; // { cardEl, originList, originNext }
    this.movingFocus = false;
    this.suppressClick = false;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onFocusOut = this.onFocusOut.bind(this);

    board.addEventListener('pointerdown', this.onPointerDown);
    board.addEventListener('keydown', this.onKeyDown);
    board.addEventListener('focusout', this.onFocusOut);
    board.addEventListener(
      'click',
      (event) => {
        if (this.suppressClick) {
          event.stopPropagation();
          event.preventDefault();
          this.suppressClick = false;
        }
      },
      true,
    );
  }

  get active() {
    return Boolean(this.lifted || this.pointer?.dragging);
  }

  // --- pointer ------------------------------------------------------------

  onPointerDown(event) {
    if (this.lifted || this.pointer) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const cardEl = event.target.closest('.card');
    if (!cardEl || !this.options.canDrag()) return;
    const onGrip = Boolean(event.target.closest('.card-grip'));
    if (!onGrip && event.target.closest(NON_DRAG_TARGETS)) return;
    // Touch scrolling must keep working on the card body: touch drags start on the grip.
    if (event.pointerType === 'touch' && !onGrip) return;
    if (onGrip) event.preventDefault();
    this.pointer = {
      cardEl,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    document.addEventListener('pointermove', this.onPointerMove, { passive: false });
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('pointercancel', this.onPointerCancel);
  }

  beginPointerDrag(event) {
    const p = this.pointer;
    const rect = p.cardEl.getBoundingClientRect();
    p.dragging = true;
    p.offsetX = event.clientX - rect.left;
    p.offsetY = event.clientY - rect.top;

    p.placeholder = document.createElement('li');
    p.placeholder.className = 'drop-placeholder';
    p.placeholder.setAttribute('aria-hidden', 'true');
    p.placeholder.style.height = `${rect.height}px`;
    p.cardEl.after(p.placeholder);

    p.ghost = p.cardEl.cloneNode(true);
    p.ghost.classList.add('is-ghost');
    p.ghost.removeAttribute('id');
    p.ghost.setAttribute('aria-hidden', 'true');
    p.ghost.style.width = `${rect.width}px`;
    document.body.append(p.ghost);
    p.cardEl.classList.add('is-source');
    document.body.classList.add('is-dragging');
    this.moveGhost(event);
  }

  moveGhost(event) {
    const p = this.pointer;
    p.ghost.style.transform = `translate3d(${event.clientX - p.offsetX}px, ${event.clientY - p.offsetY}px, 0) rotate(2deg)`;
  }

  onPointerMove(event) {
    const p = this.pointer;
    if (!p || event.pointerId !== p.pointerId) return;
    if (!p.dragging) {
      const distance = Math.hypot(event.clientX - p.startX, event.clientY - p.startY);
      if (distance < DRAG_THRESHOLD_PX) return;
      this.beginPointerDrag(event);
    }
    event.preventDefault();
    this.moveGhost(event);
    this.autoScroll(event);

    const under = document.elementFromPoint(event.clientX, event.clientY);
    const list = under?.closest('.card-list');
    if (!list || !this.board.contains(list)) return;
    const siblings = cardsIn(list, p.cardEl);
    const before = siblings.find((el) => {
      const rect = el.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (before) {
      if (p.placeholder.nextElementSibling !== before) before.before(p.placeholder);
    } else if (list.lastElementChild !== p.placeholder) {
      list.append(p.placeholder);
    }
  }

  autoScroll(event) {
    const rect = this.scroller.getBoundingClientRect();
    if (event.clientX < rect.left + EDGE_SCROLL_PX) this.scroller.scrollLeft -= 16;
    else if (event.clientX > rect.right - EDGE_SCROLL_PX) this.scroller.scrollLeft += 16;
    const list = document.elementFromPoint(event.clientX, event.clientY)?.closest('.card-list');
    if (list) {
      const listRect = list.getBoundingClientRect();
      if (event.clientY < listRect.top + EDGE_SCROLL_PX) list.scrollTop -= 12;
      else if (event.clientY > listRect.bottom - EDGE_SCROLL_PX) list.scrollTop += 12;
    }
  }

  onPointerUp(event) {
    const p = this.pointer;
    if (!p || event.pointerId !== p.pointerId) return;
    if (!p.dragging) {
      this.endPointer();
      return;
    }
    const list = p.placeholder.parentElement;
    const index = list ? cardsIn(list, p.cardEl).filter((el) => this.precedes(el, p.placeholder)).length : -1;
    const cardId = p.cardEl.dataset.id;
    const columnId = list?.closest('.column')?.dataset.id;
    this.suppressClick = true;
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    this.endPointer();
    if (columnId && index >= 0) this.options.onDrop({ cardId, columnId, index });
    else this.options.onCancel();
  }

  onPointerCancel(event) {
    if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
    const wasDragging = this.pointer.dragging;
    this.endPointer();
    if (wasDragging) this.options.onCancel();
  }

  cancelPointer() {
    if (!this.pointer) return;
    const wasDragging = this.pointer.dragging;
    this.endPointer();
    if (wasDragging) this.options.onCancel();
  }

  precedes(a, b) {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  endPointer() {
    const p = this.pointer;
    if (!p) return;
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('pointercancel', this.onPointerCancel);
    p.ghost?.remove();
    p.placeholder?.remove();
    p.cardEl.classList.remove('is-source');
    document.body.classList.remove('is-dragging');
    this.pointer = null;
  }

  // --- keyboard -----------------------------------------------------------

  onKeyDown(event) {
    if (this.pointer?.dragging && event.key === 'Escape') {
      event.preventDefault();
      this.cancelPointer();
      return;
    }
    const grip = event.target.closest('.card-grip');
    if (!grip) return;
    const cardEl = grip.closest('.card');
    const isToggle = event.key === ' ' || event.key === 'Enter';

    if (!this.lifted) {
      if (!isToggle || !this.options.canDrag()) return;
      event.preventDefault();
      this.lift(cardEl);
      return;
    }
    if (this.lifted.cardEl !== cardEl) return;

    const directions = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Home: 'top',
      End: 'bottom',
    };
    if (directions[event.key]) {
      event.preventDefault();
      this.moveLifted(directions[event.key]);
    } else if (isToggle) {
      event.preventDefault();
      this.dropLifted();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelLifted(true);
    } else if (event.key === 'Tab') {
      this.cancelLifted(false);
    }
  }

  lift(cardEl) {
    this.lifted = { cardEl, originList: cardEl.parentElement, originNext: cardEl.nextElementSibling };
    cardEl.classList.add('is-lifted');
    cardEl.querySelector('.card-grip').setAttribute('aria-pressed', 'true');
    const d = this.options.describe(cardEl);
    this.options.announce(
      `Picked up “${d.title}”. Position ${d.position} of ${d.total} in ${d.column}. ` +
        'Use the arrow keys to move, Space to drop, Escape to cancel.',
    );
  }

  moveLifted(direction) {
    const { cardEl } = this.lifted;
    const lists = [...this.board.querySelectorAll('.card-list')];
    let listIndex = lists.indexOf(cardEl.parentElement);
    let index = cardsIn(cardEl.parentElement, cardEl).filter((el) => this.precedes(el, cardEl)).length;
    if (direction === 'up') index -= 1;
    if (direction === 'down') index += 1;
    if (direction === 'top') index = 0;
    if (direction === 'left') listIndex -= 1;
    if (direction === 'right') listIndex += 1;
    listIndex = Math.max(0, Math.min(listIndex, lists.length - 1));
    const target = lists[listIndex];
    const siblings = cardsIn(target, cardEl);
    if (direction === 'bottom') index = siblings.length;
    index = Math.max(0, Math.min(index, siblings.length));

    const grip = cardEl.querySelector('.card-grip');
    this.movingFocus = true;
    if (index < siblings.length) siblings[index].before(cardEl);
    else target.append(cardEl);
    grip.focus();
    cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.movingFocus = false;

    const d = this.options.describe(cardEl);
    this.options.announce(`Position ${d.position} of ${d.total} in ${d.column}.`);
  }

  dropLifted() {
    const { cardEl } = this.lifted;
    const list = cardEl.parentElement;
    const index = cardsIn(list, cardEl).filter((el) => this.precedes(el, cardEl)).length;
    const d = this.options.describe(cardEl);
    this.releaseLifted();
    this.options.announce(`Dropped “${d.title}” at position ${d.position} of ${d.total} in ${d.column}.`);
    this.options.onDrop({ cardId: cardEl.dataset.id, columnId: list.closest('.column').dataset.id, index });
  }

  cancelLifted(refocus) {
    const { cardEl, originList, originNext } = this.lifted;
    this.movingFocus = true;
    if (originNext && originNext.parentElement === originList) originNext.before(cardEl);
    else originList.append(cardEl);
    if (refocus) cardEl.querySelector('.card-grip').focus();
    this.movingFocus = false;
    this.releaseLifted();
    this.options.announce('Move cancelled.');
    this.options.onCancel();
  }

  releaseLifted() {
    const { cardEl } = this.lifted;
    cardEl.classList.remove('is-lifted');
    cardEl.querySelector('.card-grip').setAttribute('aria-pressed', 'false');
    this.lifted = null;
  }

  onFocusOut(event) {
    if (!this.lifted || this.movingFocus) return;
    if (event.target.closest('.card') === this.lifted.cardEl && !this.lifted.cardEl.contains(event.relatedTarget)) {
      this.cancelLifted(false);
    }
  }
}
