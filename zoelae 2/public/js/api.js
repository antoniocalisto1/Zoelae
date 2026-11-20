// Thin fetch wrapper. Cookies carry the session, so every call is same-origin with credentials.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Something went wrong.');
    this.status = status;
    this.body = body || {};
  }
}

async function request(method, path, { body, formData } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (formData) {
    init.body = formData;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);
  if (res.status === 204) return null;

  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = { message: text }; } }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),
  postForm: (path, formData) => request('POST', path, { formData }),
  patchForm: (path, formData) => request('PATCH', path, { formData })
};
