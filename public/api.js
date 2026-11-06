// Access tokens deliberately never enter persistent browser storage.
export class ApiError extends Error {
  constructor(status, error = {}) {
    super(error.message || `Request failed (${status})`);
    this.status = status;
    this.code = error.code;
    this.details = Array.isArray(error.details) ? error.details : [];
    this.requestId = error.requestId;
  }
}

export function createApi(onUnauthorized) {
  let token = null;
  return {
    setToken(value) { token = value; },
    async request(path, { method = 'GET', body, signal, anonymous = false } = {}) {
      const headers = { Accept: 'application/json' };
      const requestToken = anonymous ? null : token;
      if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`/api${path}`, {
        method, headers, signal, credentials: 'omit', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (signal?.aborted) throw new DOMException('Request canceled', 'AbortError');
      if (response.status === 204) return null;
      let payload;
      try { payload = await response.json(); }
      catch {
        if (response.status === 401 && requestToken && requestToken === token) onUnauthorized();
        throw new Error('The server returned an unreadable response. Please try again.');
      }
      if (!response.ok) {
        const error = new ApiError(response.status, payload.error);
        if (response.status === 401 && requestToken && requestToken === token) onUnauthorized();
        throw error;
      }
      return payload;
    }
  };
}
