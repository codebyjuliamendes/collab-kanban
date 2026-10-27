/**
 * Client-side board state.
 *
 * `confirmed` mirrors the server (snapshot + events in seq order). `pending`
 * holds the local operations the server has not acknowledged yet. What the
 * user sees is `view()`: confirmed state with pending operations replayed on
 * top, so local edits show up immediately and are rebased automatically when
 * other people's changes arrive.
 *
 * Pure module (no DOM, no network) so it is unit tested under Node.
 */

const rank = () => globalThis.Rank;

/** @typedef {{ id: string, title: string, rank: string, version: number, deleted?: boolean }} Column */
/** @typedef {{ id: string, columnId: string, title: string, description: string, rank: string, version: number, deleted?: boolean }} Card */

const clone = (value) => JSON.parse(JSON.stringify(value));

export function emptyConfirmed() {
  return { seq: 0, board: null, columns: new Map(), cards: new Map() };
}

export function confirmedFromSnapshot(snapshot) {
  return {
    seq: snapshot.seq,
    board: snapshot.board,
    columns: new Map(snapshot.columns.map((column) => [column.id, column])),
    cards: new Map(snapshot.cards.map((card) => [card.id, card])),
  };
}

/**
 * Applies a server event. Returns 'applied', 'stale' (already seen) or
 * 'gap' (an event was missed: the caller must resynchronise).
 */
export function applyEvent(confirmed, event) {
  if (event.seq <= confirmed.seq) return 'stale';
  if (event.seq !== confirmed.seq + 1) return 'gap';
  for (const { kind, entity } of event.changes) {
    const map = kind === 'card' ? confirmed.cards : confirmed.columns;
    if (entity.deleted) map.delete(entity.id);
    else map.set(entity.id, entity);
  }
  confirmed.seq = event.seq;
  return 'applied';
}

const sortedColumns = (state) => [...state.columns.values()].sort(rank().compare);
const sortedCards = (state, columnId) =>
  [...state.cards.values()].filter((card) => card.columnId === columnId).sort(rank().compare);

/** Optimistically applies one operation, mirroring the server rules. Returns false if it would not apply. */
export function applyOpLocally(state, op) {
  const R = rank();
  switch (op.type) {
    case 'column.create': {
      if (state.columns.has(op.id)) return false;
      const { rank: r } = R.place(sortedColumns(state), op);
      state.columns.set(op.id, { id: op.id, title: op.title, rank: r, version: 1 });
      return true;
    }
    case 'column.update': {
      const column = state.columns.get(op.id);
      if (!column || column.version !== op.baseVersion) return false;
      state.columns.set(op.id, { ...column, title: op.title, version: column.version + 1 });
      return true;
    }
    case 'column.move': {
      const column = state.columns.get(op.id);
      if (!column) return false;
      const siblings = sortedColumns(state).filter((c) => c.id !== op.id);
      state.columns.set(op.id, { ...column, rank: R.place(siblings, op).rank });
      return true;
    }
    case 'column.delete': {
      if (!state.columns.has(op.id)) return false;
      state.columns.delete(op.id);
      for (const card of [...state.cards.values()]) if (card.columnId === op.id) state.cards.delete(card.id);
      return true;
    }
    case 'card.create': {
      if (state.cards.has(op.id) || !state.columns.has(op.columnId)) return false;
      const { rank: r } = R.place(sortedCards(state, op.columnId), op);
      state.cards.set(op.id, {
        id: op.id,
        columnId: op.columnId,
        title: op.title,
        description: op.description || '',
        rank: r,
        version: 1,
      });
      return true;
    }
    case 'card.update': {
      const card = state.cards.get(op.id);
      if (!card || card.version !== op.baseVersion) return false;
      state.cards.set(op.id, {
        ...card,
        title: op.title ?? card.title,
        description: op.description ?? card.description,
        version: card.version + 1,
      });
      return true;
    }
    case 'card.move': {
      const card = state.cards.get(op.id);
      if (!card || !state.columns.has(op.columnId)) return false;
      const siblings = sortedCards(state, op.columnId).filter((c) => c.id !== op.id);
      state.cards.set(op.id, { ...card, columnId: op.columnId, rank: R.place(siblings, op).rank });
      return true;
    }
    case 'card.delete': {
      return state.cards.delete(op.id);
    }
    default:
      return false;
  }
}

/** Confirmed state plus pending operations, as plain sorted arrays for rendering. */
export function view(confirmed, pending) {
  const state = {
    columns: new Map([...confirmed.columns].map(([id, column]) => [id, { ...column }])),
    cards: new Map([...confirmed.cards].map(([id, card]) => [id, { ...card }])),
  };
  for (const op of pending) applyOpLocally(state, op);
  const columns = sortedColumns(state).map((column) => ({ ...column, cards: sortedCards(state, column.id) }));
  return { columns, cards: state.cards, columnsById: state.columns };
}

/**
 * Computes the anchor (`afterId`/`beforeId`) for dropping an item at `index`
 * of `ids`, the target list in display order WITHOUT the moving item.
 */
export function anchorAt(ids, index) {
  const clamped = Math.max(0, Math.min(index, ids.length));
  return {
    afterId: clamped === 0 ? null : ids[clamped - 1],
    ...(clamped < ids.length ? { beforeId: ids[clamped] } : {}),
  };
}

/**
 * Keyboard move: where a card ends up after pressing an arrow key.
 * @param {{ id: string, cards: { id: string }[] }[]} columns display order
 * @param {{ columnIndex: number, index: number }} position current position of the card
 * @param {'up'|'down'|'left'|'right'|'top'|'bottom'} direction
 * @param {string} cardId
 */
export function keyboardTarget(columns, position, direction, cardId) {
  let { columnIndex, index } = position;
  const othersIn = (i) => columns[i].cards.filter((card) => card.id !== cardId);
  if (direction === 'up') index -= 1;
  if (direction === 'down') index += 1;
  if (direction === 'top') index = 0;
  if (direction === 'bottom') index = othersIn(columnIndex).length;
  if (direction === 'left') columnIndex -= 1;
  if (direction === 'right') columnIndex += 1;
  columnIndex = Math.max(0, Math.min(columnIndex, columns.length - 1));
  index = Math.max(0, Math.min(index, othersIn(columnIndex).length));
  return { columnIndex, index };
}

export { clone };
