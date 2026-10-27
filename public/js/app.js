import { api } from './api.js';
import { DragDrop } from './dnd.js';
import { anchorAt, view } from './state.js';
import { boards, prefs } from './storage.js';
import { BoardSession, uid } from './sync.js';

/**
 * UI layer. All user-provided text is written with `textContent` / `value`,
 * never as HTML, so card and column content cannot inject markup.
 */

const $ = (selector, root = document) => root.querySelector(selector);

const els = {
  homeView: $('#home-view'),
  boardView: $('#board-view'),
  messageView: $('#message-view'),
  board: $('#board'),
  scroller: $('#board-scroller'),
  boardTitle: $('#board-title'),
  status: $('#connection-status'),
  presence: $('#presence'),
  shareBtn: $('#share-btn'),
  nameBtn: $('#name-btn'),
  themeBtn: $('#theme-btn'),
  addColumnBtn: $('#add-column-btn'),
  readonlyBanner: $('#readonly-banner'),
  announcer: $('#announcer'),
  toasts: $('#toasts'),
  columnTemplate: $('#column-template'),
  cardTemplate: $('#card-template'),
  cardDialog: $('#card-dialog'),
  shareDialog: $('#share-dialog'),
  nameDialog: $('#name-dialog'),
};

let session = null;
let currentBoardId = null;
let renderQueued = false;
let renderDeferred = false;
let editing = null; // { cardId, baseVersion }

// --- small helpers ----------------------------------------------------------

function announce(message) {
  els.announcer.textContent = '';
  // A fresh text node makes screen readers re-announce identical messages.
  requestAnimationFrame(() => {
    els.announcer.textContent = message;
  });
}

function toast(message, kind = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  els.toasts.append(item);
  setTimeout(() => item.classList.add('leaving'), 4500);
  setTimeout(() => item.remove(), 5000);
}

function displayName() {
  return prefs.get('name', '') || 'Guest';
}

function syncNameButton() {
  const name = prefs.get('name', '');
  els.nameBtn.querySelector('.btn-label').textContent = name || 'Your name';
  els.nameBtn.setAttribute('aria-label', name ? `Display name: ${name}. Change` : 'Set your display name');
}

function closeDialogOnBackdrop(dialog) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
}

function boardLink(boardId, token) {
  const url = new URL(window.location.href);
  url.hash = `board=${encodeURIComponent(boardId)}&key=${encodeURIComponent(token)}`;
  return url.toString();
}

// --- theme --------------------------------------------------------------------

function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeButton() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  els.themeBtn.setAttribute('aria-label', `Switch to ${next} theme`);
  els.themeBtn.title = `Switch to ${next} theme`;
}

els.themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  prefs.set('theme', next);
  syncThemeButton();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);
syncThemeButton();

// --- routing ------------------------------------------------------------------

function parseHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { boardId: params.get('board'), key: params.get('key') };
}

function route() {
  const { boardId, key } = parseHash();
  if (boardId && key) {
    // Keep the secret out of the address bar and history once stored.
    boards.save(boardId, { token: key });
    history.replaceState(null, '', `${window.location.pathname}#board=${encodeURIComponent(boardId)}`);
  }
  if (boardId) openBoard(boardId);
  else showHome();
}

function showOnly(viewEl) {
  for (const el of [els.homeView, els.boardView, els.messageView]) el.hidden = el !== viewEl;
}

function leaveBoard() {
  if (session) session.stop();
  session = null;
  currentBoardId = null;
  els.boardTitle.hidden = true;
  els.status.hidden = true;
  els.presence.hidden = true;
  els.shareBtn.hidden = true;
  els.addColumnBtn.hidden = true;
  document.title = 'Collab Kanban';
}

function showMessage(title, body) {
  leaveBoard();
  $('#message-title').textContent = title;
  $('#message-body').textContent = body;
  showOnly(els.messageView);
}

// --- home ---------------------------------------------------------------------

function showHome() {
  leaveBoard();
  showOnly(els.homeView);
  const list = $('#board-list');
  list.replaceChildren();
  const entries = Object.entries(boards.all()).filter(([, entry]) => entry.token);
  for (const [id, entry] of entries) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#board=${encodeURIComponent(id)}`;
    link.textContent = entry.title || 'Untitled board';
    const role = document.createElement('span');
    role.className = 'pill';
    role.textContent = entry.role === 'viewer' ? 'View only' : entry.role === 'editor' ? 'Can edit' : 'Shared';
    li.append(link, role);
    list.append(li);
  }
  $('#board-list-empty').hidden = entries.length > 0;
}

$('#create-board-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = $('#board-title-input');
  const error = $('#create-board-error');
  const button = form.querySelector('button[type="submit"]');
  const title = input.value.trim();
  error.textContent = '';
  if (!title) {
    error.textContent = 'Give the board a name.';
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Creating…';
  try {
    const { board, editorToken, viewerToken } = await api.createBoard(title);
    boards.save(board.id, {
      title: board.title,
      token: editorToken,
      role: 'editor',
      links: { editor: editorToken, viewer: viewerToken },
    });
    input.value = '';
    window.location.hash = `board=${encodeURIComponent(board.id)}`;
  } catch (err) {
    error.textContent =
      err.status === 401
        ? 'Creating boards is restricted on this server. Ask the administrator for a board.'
        : err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Create board';
  }
});

// --- board --------------------------------------------------------------------

function openBoard(boardId) {
  const entry = boards.get(boardId);
  if (!entry?.token) {
    showMessage(
      'You need an invite link',
      'This board is not saved on this device. Open the link that was shared with you (it includes an access key).',
    );
    return;
  }
  if (currentBoardId === boardId && session) return;
  leaveBoard();
  currentBoardId = boardId;
  showOnly(els.boardView);
  els.boardTitle.hidden = false;
  els.boardTitle.textContent = entry.title || 'Board';
  els.status.hidden = false;
  els.board.setAttribute('aria-busy', 'true');

  session = new BoardSession({
    boardId,
    token: entry.token,
    name: displayName(),
    handlers: {
      onChange: scheduleRender,
      onStatus: renderStatus,
      onPresence: renderPresence,
      onRejected: handleRejected,
      onUnauthorized: (reason) => {
        boards.save(boardId, { token: null });
        showMessage(
          reason === 'revoked' ? 'Your access was revoked' : 'This link is not valid',
          'Ask a board editor for a new invite link.',
        );
      },
      onRole: (role) => {
        boards.save(boardId, { role });
        applyRole(role);
      },
    },
  });
  // Until the server confirms, trust the cached role so offline edits keep working.
  session.role = entry.role || null;
  applyRole(entry.role || 'viewer', true);
  if (session.hasData) scheduleRender();
  session.start();
}

function canEdit() {
  return session?.role === 'editor';
}

function applyRole(role, provisional = false) {
  const editor = role === 'editor';
  document.body.classList.toggle('read-only', !editor);
  els.readonlyBanner.hidden = editor || provisional;
  els.addColumnBtn.hidden = !editor;
  els.shareBtn.hidden = !editor;
}

function renderStatus({ state, pending }) {
  const labels = {
    online: 'Live',
    connecting: 'Connecting…',
    offline: 'Offline',
    unauthorized: 'No access',
  };
  let text = labels[state] || state;
  if (pending > 0 && state !== 'online') text += ` · ${pending} unsaved`;
  else if (pending > 0) text += ' · saving…';
  els.status.textContent = text;
  els.status.dataset.state = state;
}

function renderPresence(users, selfId) {
  els.presence.replaceChildren();
  const others = users.filter((user) => user.id !== selfId);
  els.presence.hidden = others.length === 0;
  for (const user of others.slice(0, 6)) {
    const li = document.createElement('li');
    li.className = 'avatar';
    li.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#64748b';
    li.textContent = (user.name || '?').slice(0, 2).toUpperCase();
    li.title = `${user.name}${user.role === 'viewer' ? ' (viewing)' : ''}`;
    li.setAttribute('aria-label', li.title);
    els.presence.append(li);
  }
  if (others.length > 6) {
    const li = document.createElement('li');
    li.className = 'avatar more';
    li.textContent = `+${others.length - 6}`;
    li.setAttribute('aria-label', `${others.length - 6} more people`);
    els.presence.append(li);
  }
}

const OP_LABELS = {
  'card.update': 'Your edit to a card',
  'card.move': 'Moving a card',
  'card.delete': 'Deleting a card',
  'card.create': 'Adding a card',
  'column.update': 'Renaming a column',
  'column.move': 'Moving a column',
  'column.delete': 'Deleting a column',
  'column.create': 'Adding a column',
};

function handleRejected(op, result) {
  if (op.type === 'card.update' && result.status === 'conflict' && result.current && !result.current.deleted) {
    // Do not lose what the user typed: reopen the editor on top of the newer version.
    openCardEditor(result.current.id, {
      draft: { title: op.title, description: op.description },
      notice:
        'Someone else changed this card while you were editing. Their version is now saved; review your text and save again to replace it.',
    });
    return;
  }
  const what = OP_LABELS[op.type] || 'A change';
  const why = result.status === 'conflict' ? 'someone else changed it first' : result.error || 'it was rejected';
  toast(`${what} was not saved: ${why}.`, 'warning');
}

// --- rendering ------------------------------------------------------------

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function focusKey(el) {
  if (!el || !els.board.contains(el)) return null;
  const card = el.closest('.card');
  const column = el.closest('.column');
  if (el.classList.contains('card-grip'))
    return { selector: `.card[data-id="${CSS.escape(card.dataset.id)}"] .card-grip` };
  if (el.classList.contains('card-open'))
    return { selector: `.card[data-id="${CSS.escape(card.dataset.id)}"] .card-open` };
  if (!column) return null;
  const base = `.column[data-id="${CSS.escape(column.dataset.id)}"]`;
  if (el.classList.contains('column-title'))
    return { selector: `${base} .column-title`, value: el.value, dirty: el.dataset.dirty === '1' };
  if (el.closest('.card-composer') && el.tagName === 'INPUT')
    return { selector: `${base} .card-composer input`, value: el.value, dirty: true };
  const action = el.dataset.action;
  if (action) return { selector: `${base} [data-action="${action}"]` };
  return null;
}

function render() {
  if (!session) return;
  if (dnd.active) {
    renderDeferred = true;
    return;
  }
  const state = view(session.confirmed, session.pending);
  const active = document.activeElement;
  const focus = focusKey(active);
  const selection =
    active && 'selectionStart' in active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const drafts = new Map();
  els.board.querySelectorAll('.card-composer input').forEach((input) => {
    if (input.value) drafts.set(input.closest('.column').dataset.id, input.value);
  });
  const scrollLeft = els.scroller.scrollLeft;
  const listScroll = new Map(
    [...els.board.querySelectorAll('.column')].map((col) => [
      col.dataset.id,
      col.querySelector('.card-list').scrollTop,
    ]),
  );

  const title = session.confirmed.board?.title;
  if (title) {
    els.boardTitle.textContent = title;
    document.title = `${title} · Collab Kanban`;
    if (boards.get(currentBoardId)?.title !== title) boards.save(currentBoardId, { title });
  }

  const fragment = document.createDocumentFragment();
  state.columns.forEach((column, columnIndex) => {
    const node = els.columnTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = column.id;
    node.setAttribute('aria-label', column.title);
    const titleInput = $('.column-title', node);
    titleInput.value = column.title;
    titleInput.readOnly = !canEdit();
    $('[data-action="column-left"]', node).disabled = columnIndex === 0;
    $('[data-action="column-right"]', node).disabled = columnIndex === state.columns.length - 1;
    const count = $('.column-count', node);
    count.textContent = `${column.cards.length} ${column.cards.length === 1 ? 'card' : 'cards'}`;
    const list = $('.card-list', node);
    list.setAttribute('aria-label', `${column.title} cards`);
    $('.column-empty', node).hidden = column.cards.length > 0;
    const composer = $('.card-composer input', node);
    composer.setAttribute('aria-label', `Add a card to ${column.title}`);
    if (drafts.has(column.id)) composer.value = drafts.get(column.id);

    column.cards.forEach((card, index) => {
      const cardNode = els.cardTemplate.content.firstElementChild.cloneNode(true);
      cardNode.dataset.id = card.id;
      $('.card-title', cardNode).textContent = card.title;
      const description = $('.card-description', cardNode);
      description.textContent = card.description;
      description.hidden = !card.description;
      $('.card-grip', cardNode).setAttribute(
        'aria-label',
        `Move “${card.title}”, position ${index + 1} of ${column.cards.length} in ${column.title}`,
      );
      $('.card-open', cardNode).setAttribute('aria-label', `${canEdit() ? 'Edit' : 'View'} card “${card.title}”`);
      list.append(cardNode);
    });
    fragment.append(node);
  });

  if (state.columns.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'board-empty';
    const heading = document.createElement('h2');
    heading.textContent = 'This board is empty';
    const text = document.createElement('p');
    text.textContent = canEdit() ? 'Add a column to start organising cards.' : 'Nothing here yet.';
    empty.append(heading, text);
    if (canEdit()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn primary';
      button.textContent = 'Add column';
      button.addEventListener('click', addColumn);
      empty.append(button);
    }
    fragment.append(empty);
  }

  els.board.replaceChildren(fragment);
  els.board.setAttribute('aria-busy', String(!session.hasData));
  els.scroller.scrollLeft = scrollLeft;
  els.board.querySelectorAll('.column').forEach((col) => {
    if (listScroll.has(col.dataset.id)) col.querySelector('.card-list').scrollTop = listScroll.get(col.dataset.id);
  });

  if (focus) {
    const target = els.board.querySelector(focus.selector);
    if (target) {
      if (focus.dirty && 'value' in target) {
        target.value = focus.value;
        if (target.classList.contains('column-title')) target.dataset.dirty = '1';
      }
      target.focus({ preventScroll: true });
      if (selection && 'setSelectionRange' in target) {
        try {
          target.setSelectionRange(selection[0], selection[1]);
        } catch {
          // Not every input type supports selection.
        }
      }
    }
  }
}

// --- board actions ------------------------------------------------------------

function submit(op) {
  if (!canEdit()) return null;
  return session.submit(op);
}

function addColumn() {
  if (!canEdit()) return;
  const id = `col_${uid()}`;
  submit({ type: 'column.create', id, title: 'New column' });
  requestAnimationFrame(() => {
    const input = els.board.querySelector(`.column[data-id="${CSS.escape(id)}"] .column-title`);
    if (input) {
      input.focus();
      input.select();
      input.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  });
}
els.addColumnBtn.addEventListener('click', addColumn);

function currentView() {
  return view(session.confirmed, session.pending);
}

function moveColumn(columnId, delta) {
  const ids = currentView().columns.map((column) => column.id);
  const from = ids.indexOf(columnId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return;
  const others = ids.filter((id) => id !== columnId);
  submit({ type: 'column.move', id: columnId, ...anchorAt(others, to) });
  const title = currentView().columnsById.get(columnId)?.title;
  announce(`Moved column ${title} to position ${to + 1} of ${ids.length}.`);
}

function commitColumnTitle(input) {
  const columnId = input.closest('.column').dataset.id;
  const column = currentView().columnsById.get(columnId);
  delete input.dataset.dirty;
  if (!column) return;
  const title = input.value.replace(/\s+/g, ' ').trim();
  if (!title) {
    input.value = column.title;
    return;
  }
  if (title !== column.title) submit({ type: 'column.update', id: columnId, baseVersion: column.version, title });
}

els.board.addEventListener('input', (event) => {
  if (event.target.classList.contains('column-title')) event.target.dataset.dirty = '1';
});
els.board.addEventListener('change', (event) => {
  if (event.target.classList.contains('column-title')) commitColumnTitle(event.target);
});
els.board.addEventListener('keydown', (event) => {
  const input = event.target;
  if (!input.classList?.contains('column-title')) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    input.blur();
  } else if (event.key === 'Escape') {
    const column = currentView().columnsById.get(input.closest('.column').dataset.id);
    if (column) input.value = column.title;
    delete input.dataset.dirty;
    input.blur();
  }
});

els.board.addEventListener('submit', (event) => {
  const form = event.target.closest('.card-composer');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input');
  const title = input.value.replace(/\s+/g, ' ').trim();
  if (!title || !canEdit()) return;
  input.value = '';
  submit({
    type: 'card.create',
    id: `card_${uid()}`,
    columnId: form.closest('.column').dataset.id,
    title,
  });
  announce(`Added card “${title}”.`);
});

els.board.addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  const column = event.target.closest('.column');
  if (actionEl && column) {
    const columnId = column.dataset.id;
    const action = actionEl.dataset.action;
    if (action === 'column-left') moveColumn(columnId, -1);
    if (action === 'column-right') moveColumn(columnId, 1);
    if (action === 'column-delete') {
      const target = currentView().columns.find((c) => c.id === columnId);
      if (!target) return;
      const cards = target.cards.length;
      const message = cards
        ? `Delete column “${target.title}” and its ${cards} ${cards === 1 ? 'card' : 'cards'}?`
        : `Delete column “${target.title}”?`;
      if (window.confirm(message)) {
        submit({ type: 'column.delete', id: columnId, baseVersion: target.version });
        announce(`Deleted column ${target.title}.`);
      }
    }
    return;
  }
  const open = event.target.closest('.card-open');
  if (open) openCardEditor(open.closest('.card').dataset.id);
});

// --- drag and drop ------------------------------------------------------------

const dnd = new DragDrop(els.board, els.scroller, {
  canDrag: () => canEdit(),
  announce,
  describe(cardEl) {
    const list = cardEl.parentElement;
    const cards = [...list.querySelectorAll(':scope > .card')].filter((el) => !el.classList.contains('is-ghost'));
    return {
      title: $('.card-title', cardEl).textContent,
      column: list.closest('.column').querySelector('.column-title').value,
      position: cards.indexOf(cardEl) + 1,
      total: cards.length,
    };
  },
  onDrop({ cardId, columnId, index }) {
    const state = currentView();
    const column = state.columns.find((c) => c.id === columnId);
    const card = state.cards.get(cardId);
    if (column && card) {
      const others = column.cards.filter((c) => c.id !== cardId).map((c) => c.id);
      const current = column.cards.findIndex((c) => c.id === cardId);
      if (!(card.columnId === columnId && current === index)) {
        submit({ type: 'card.move', id: cardId, columnId, ...anchorAt(others, index) });
      }
    }
    flushDeferredRender(true);
  },
  onCancel: () => flushDeferredRender(true),
});

function flushDeferredRender(force) {
  if (renderDeferred || force) {
    renderDeferred = false;
    scheduleRender();
  }
}

// --- card editor --------------------------------------------------------------

const cardForm = $('#card-form');
const cardTitleInput = $('#card-title-input');
const cardDescriptionInput = $('#card-description-input');
const cardConflict = $('#card-conflict');
const cardError = $('#card-form-error');
let editorReturnFocus = null;

function openCardEditor(cardId, { draft, notice } = {}) {
  const card = currentView().cards.get(cardId);
  if (!card) return;
  if (els.cardDialog.open && editing?.cardId !== cardId) return;
  editing = { cardId, baseVersion: card.version };
  editorReturnFocus =
    els.board.querySelector(`.card[data-id="${CSS.escape(cardId)}"] .card-open`) || document.activeElement;
  $('#card-dialog-title').textContent = canEdit() ? 'Edit card' : 'Card';
  cardTitleInput.value = draft?.title ?? card.title;
  cardDescriptionInput.value = draft?.description ?? card.description ?? '';
  cardTitleInput.readOnly = !canEdit();
  cardDescriptionInput.readOnly = !canEdit();
  cardForm.querySelector('button[type="submit"]').hidden = !canEdit();
  $('#card-delete-btn').hidden = !canEdit();
  cardConflict.hidden = !notice;
  cardConflict.textContent = notice || '';
  cardError.textContent = '';
  if (!els.cardDialog.open) els.cardDialog.showModal();
  cardTitleInput.focus();
}

cardForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!editing || !canEdit()) return els.cardDialog.close();
  const title = cardTitleInput.value.replace(/\s+/g, ' ').trim();
  if (!title) {
    cardError.textContent = 'The title cannot be empty.';
    cardTitleInput.focus();
    return undefined;
  }
  const card = currentView().cards.get(editing.cardId);
  if (!card) {
    els.cardDialog.close();
    toast('This card was deleted by someone else.', 'warning');
    return undefined;
  }
  const description = cardDescriptionInput.value;
  if (title !== card.title || description !== (card.description || '')) {
    // baseVersion is the version the user started editing from: a concurrent
    // edit by someone else is reported as a conflict instead of overwritten.
    submit({ type: 'card.update', id: card.id, baseVersion: editing.baseVersion, title, description });
  }
  els.cardDialog.close();
  return undefined;
});

$('#card-delete-btn').addEventListener('click', () => {
  if (!editing) return;
  const card = currentView().cards.get(editing.cardId);
  if (card && window.confirm(`Delete card “${card.title}”?`)) {
    submit({ type: 'card.delete', id: card.id, baseVersion: editing.baseVersion });
    announce(`Deleted card “${card.title}”.`);
    editorReturnFocus = null;
    els.cardDialog.close();
  }
});

els.cardDialog.addEventListener('close', () => {
  editing = null;
  if (editorReturnFocus?.isConnected) editorReturnFocus.focus();
  else {
    const fresh = editorReturnFocus?.closest?.('.card')?.dataset.id;
    els.board.querySelector(fresh ? `.card[data-id="${CSS.escape(fresh)}"] .card-open` : '.card-open')?.focus();
  }
});
closeDialogOnBackdrop(els.cardDialog);

// --- share dialog ---------------------------------------------------------------

function fillShareDialog() {
  const entry = boards.get(currentBoardId) || {};
  const links = entry.links || {};
  if (entry.role === 'editor' && !links.editor) links.editor = entry.token;
  els.shareDialog.querySelectorAll('.share-row').forEach((row) => {
    const token = links[row.dataset.role];
    row.querySelector('input').value = token ? boardLink(currentBoardId, token) : '';
  });
  $('#share-error').textContent = '';
}

els.shareBtn.addEventListener('click', () => {
  fillShareDialog();
  els.shareDialog.showModal();
});

els.shareDialog.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('.share-row');
  const role = row.dataset.role;
  const input = row.querySelector('input');
  const entry = boards.get(currentBoardId);
  const error = $('#share-error');
  error.textContent = '';

  if (button.dataset.action === 'copy') {
    if (!input.value) {
      error.textContent = 'Generate a link first.';
      return;
    }
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Link copied.', 'success');
    } catch {
      input.select();
      error.textContent = 'Copy failed. The link is selected: copy it manually.';
    }
    return;
  }

  button.disabled = true;
  try {
    if (button.dataset.action === 'generate') {
      const { token } = await api.createInvite(currentBoardId, entry.token, role);
      boards.save(currentBoardId, { links: { ...(entry.links || {}), [role]: token } });
      input.value = boardLink(currentBoardId, token);
      toast('New link created.', 'success');
    } else if (button.dataset.action === 'revoke') {
      const label = role === 'editor' ? 'all other edit links (yours keeps working)' : 'all view links';
      if (!window.confirm(`Revoke ${label}? People using them lose access immediately.`)) return;
      const { revoked } = await api.revokeInvites(currentBoardId, entry.token, role);
      const links = { ...(entry.links || {}) };
      if (role === 'viewer') delete links.viewer;
      else links.editor = entry.token;
      boards.save(currentBoardId, { links });
      fillShareDialog();
      toast(`${revoked} ${revoked === 1 ? 'link' : 'links'} revoked.`, 'success');
    }
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#forget-board-btn').addEventListener('click', () => {
  if (!window.confirm('Remove this board from this device? You will need an invite link to open it again.')) return;
  const id = currentBoardId;
  els.shareDialog.close();
  leaveBoard();
  boards.forget(id);
  window.location.hash = '';
});
closeDialogOnBackdrop(els.shareDialog);

// --- display name ---------------------------------------------------------------

els.nameBtn.addEventListener('click', () => {
  $('#name-input').value = prefs.get('name', '');
  els.nameDialog.showModal();
});
$('#name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#name-input').value.replace(/\s+/g, ' ').trim().slice(0, 40);
  prefs.set('name', name);
  session?.setName(name || 'Guest');
  syncNameButton();
  els.nameDialog.close();
});
closeDialogOnBackdrop(els.nameDialog);

// --- boot -----------------------------------------------------------------------

window.addEventListener('hashchange', route);
syncNameButton();
route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline caching is optional; the app works without it.
    });
  });
}
