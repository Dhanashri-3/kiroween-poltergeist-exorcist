// The only configured value: the API base URL (see docs/api.md).
// docs/api.md puts every endpoint under `/api/v1` and documents the Dashboard
// calling it with that relative prefix. It does not document a backend port, so
// the default is the relative prefix. Set VITE_API_BASE_URL to point at a
// running backend, for example http://127.0.0.1:<port>/api/v1.
export const DEFAULT_API_BASE_URL = '/api/v1';

export function resolveApiBaseUrl(env = import.meta.env) {
  const value = env && env.VITE_API_BASE_URL;
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_API_BASE_URL;
  return value.trim().replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();
