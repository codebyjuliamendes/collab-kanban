/** REST calls used outside the real-time channel (board creation and invites). */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code || 'error', data.error?.message || 'Request failed');
  }
  return data;
}

export const api = {
  createBoard: (title) => request('POST', '/api/boards', { body: { title } }),
  createInvite: (boardId, token, role) =>
    request('POST', `/api/boards/${encodeURIComponent(boardId)}/invites`, { token, body: { role } }),
  revokeInvites: (boardId, token, role) =>
    request('POST', `/api/boards/${encodeURIComponent(boardId)}/invites/revoke`, { token, body: { role } }),
};
