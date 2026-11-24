/**
 * API client (task 14.5; Requirements 15.4, 15.8, 15.9, 15.11). Contract: docs/api.md.
 *
 * Framework-free. Every method returns the parsed JSON body of a successful response or throws an
 * ApiError. Nothing here interprets a response as an outcome (Req 15.8): callers read state from Events.
 */
import { API_BASE_URL } from '../config.js';

export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;

const invalidResponse = (status, message) => new ApiError({ status, code: 'invalid_response', message });

// Shape checks for success bodies. A body that does not match is an invalid_response.
const SHAPES = {
  health: (b) => isObject(b),
  scenarios: (b) => isObject(b) && Array.isArray(b.scenarios),
  incidents: (b) => isObject(b) && Array.isArray(b.incidents),
  incident: (b) => isObject(b),
  verification: (b) => isObject(b),
  events: (b) => isObject(b) && Array.isArray(b.events),
  chaos: (b) => isObject(b) && typeof b.runId === 'string' && b.runId !== '',
  reset: (b) => isObject(b),
};

export function createApiClient({ baseUrl = API_BASE_URL, fetchImpl } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, { query, body, shape, signal } = {}) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new ApiError({ status: 0, code: 'network_error', message: 'fetch is not available.' });
    }
    let url = `${base}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) params.set(key, String(value));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const init = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (signal) init.signal = signal;

    let response;
    try {
      response = await doFetch(url, init);
    } catch (cause) {
      if (cause && cause.name === 'AbortError') throw cause;
      throw new ApiError({ status: 0, code: 'network_error', message: cause?.message || 'Network request failed.' });
    }

    let text;
    try {
      text = await response.text();
    } catch (cause) {
      if (cause && cause.name === 'AbortError') throw cause;
      throw new ApiError({ status: 0, code: 'network_error', message: cause?.message || 'Network read failed.' });
    }
    let parsed;
    let parseFailed = false;
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    if (!response.ok) {
      if (!parseFailed && isObject(parsed) && isObject(parsed.error) &&
          typeof parsed.error.code === 'string' && typeof parsed.error.message === 'string') {
        throw new ApiError({
          status: response.status,
          code: parsed.error.code,
          message: parsed.error.message,
          details: parsed.error.details,
        });
      }
      throw invalidResponse(response.status, `Unexpected error response (HTTP ${response.status}).`);
    }
    if (parseFailed) throw invalidResponse(response.status, 'Response body is not valid JSON.');
    if (shape && !SHAPES[shape](parsed)) throw invalidResponse(response.status, 'Response body has an unexpected shape.');
    return parsed;
  }

  return {
    baseUrl: base,
    getHealth: (opts) => request('GET', '/health', { shape: 'health', ...opts }),
    getScenarios: (opts) => request('GET', '/scenarios', { shape: 'scenarios', ...opts }),
    getIncidents: (opts) => request('GET', '/incidents', { shape: 'incidents', ...opts }),
    getIncident: (id, opts) => request('GET', `/incidents/${encodeURIComponent(id)}`, { shape: 'incident', ...opts }),
    getVerification: (id, opts) =>
      request('GET', `/incidents/${encodeURIComponent(id)}/verification`, { shape: 'verification', ...opts }),
    getEvents: ({ afterSeq, incidentId } = {}, opts) => {
      const query = {};
      if (isNonNegativeInteger(afterSeq)) query.afterSeq = afterSeq;
      if (typeof incidentId === 'string' && incidentId !== '') query.incidentId = incidentId;
      return request('GET', '/events', { query, shape: 'events', ...opts });
    },
    startChaosRun: (scenarioId, opts) =>
      request('POST', '/chaos-runs', {
        body: typeof scenarioId === 'string' && scenarioId !== '' ? { scenarioId } : {},
        shape: 'chaos',
        ...opts,
      }),
    reset: (opts) => request('POST', '/reset', { body: {}, shape: 'reset', ...opts }),
  };
}

/**
 * Loads health, scenarios, incidents and events and dispatches {kind:'api', endpoint, response} for each
 * that succeeds. A failing endpoint is collected in `errors` and the others still load.
 * Returns { errors: [{endpoint, error}], maxSeq } where maxSeq is the highest valid Event seq loaded (0 if none).
 */
export async function loadSnapshot({ client, dispatch, signal } = {}) {
  const calls = [
    ['health', () => client.getHealth({ signal })],
    ['scenarios', () => client.getScenarios({ signal })],
    ['incidents', () => client.getIncidents({ signal })],
    ['events', () => client.getEvents({}, { signal })],
  ];
  const errors = [];
  let maxSeq = 0;
  await Promise.all(calls.map(async ([endpoint, call]) => {
    try {
      const response = await call();
      if (signal?.aborted) return;
      if (endpoint === 'events') {
        for (const e of response.events) {
          if (isObject(e) && isNonNegativeInteger(e.seq) && e.seq > maxSeq) maxSeq = e.seq;
        }
      }
      dispatch({ kind: 'api', endpoint, response });
    } catch (error) {
      if (signal?.aborted) return;
      errors.push({ endpoint, error });
    }
  }));
  return { errors, maxSeq };
}
