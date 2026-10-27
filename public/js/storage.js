/**
 * Small, failure-tolerant wrapper over localStorage. Storage can be disabled
 * (private mode, policies), so every access is guarded and the app keeps
 * working in memory.
 */
const PREFIX = 'collab-kanban:';

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled: keep going in memory.
  }
}

function remove(key) {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/** Boards this browser has access to: { [boardId]: { title, token, role, links } }. */
export const boards = {
  all: () => read('boards', {}),
  get: (id) => read('boards', {})[id] || null,
  save(id, entry) {
    const all = read('boards', {});
    all[id] = { ...all[id], ...entry };
    write('boards', all);
  },
  forget(id) {
    const all = read('boards', {});
    delete all[id];
    write('boards', all);
    remove(`board:${id}`);
  },
};

/** Offline cache of a board: last snapshot and unacknowledged operations. */
export const boardCache = {
  load: (id) => read(`board:${id}`, null),
  save: (id, data) => write(`board:${id}`, data),
};

export const prefs = {
  get: (key, fallback) => read(`pref:${key}`, fallback),
  set: (key, value) => write(`pref:${key}`, value),
};
