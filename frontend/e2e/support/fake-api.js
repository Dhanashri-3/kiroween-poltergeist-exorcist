/**
 * FAKE API for Dashboard UI-contract tests (Task 14.8 harness). NOT the real backend.
 *
 * This is a dependency-free Node `http` stand-in for the API documented in docs/api.md. It lets a
 * browser test drive the Dashboard deterministically: push Events, drop SSE connections, force
 * status codes. It proves that the Dashboard renders and requests according to the documented
 * contract. It does NOT prove that the real Exorcist recovers anything, and nothing it returns is a
 * real Verification_Result. Every Event it emits is created by a test, never by the fake itself:
 * POST /chaos-runs and POST /reset only answer and log the request; they never change health,
 * Incidents or Events (this is what lets the suite check Req 15.8).
 *
 * Events are schema-valid (UUID id, ISO ts, all 8 fields, known type) and are validated on push.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = [
  'chaos.selection', 'chaos.injection', 'chaos.rejected', 'detection', 'transient', 'cleared',
  'incident.state', 'diagnosis', 'plan', 'gate', 'repair', 'verification', 'rollback',
  'escalation', 'recovery', 'battle_result', 'reset', 'security', 'error', 'timeout',
];
const EVENT_KEYS = ['id', 'seq', 'ts', 'type', 'component', 'incidentId', 'runId', 'payload'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const API = '/api/v1';

export function assertValidEvent(e) {
  const problems = [];
  const keys = Object.keys(e);
  if (keys.length !== EVENT_KEYS.length || !EVENT_KEYS.every((k) => keys.includes(k))) problems.push('keys');
  if (!UUID.test(e.id)) problems.push('id');
  if (!Number.isInteger(e.seq) || e.seq < 1) problems.push('seq');
  if (!ISO.test(e.ts)) problems.push('ts');
  if (!EVENT_TYPES.includes(e.type)) problems.push('type');
  if (typeof e.component !== 'string' || e.component === '') problems.push('component');
  if (e.incidentId !== null && (typeof e.incidentId !== 'string' || e.incidentId === '')) problems.push('incidentId');
  if (e.runId !== null && (typeof e.runId !== 'string' || e.runId === '')) problems.push('runId');
  if (e.payload === null || typeof e.payload !== 'object' || Array.isArray(e.payload)) problems.push('payload');
  if (problems.length > 0) throw new Error(`Fake API refused to emit an invalid Event (${problems.join(', ')})`);
}

const DEFAULT_HEALTH = {
  status: 'ok',
  testApp: {
    reachable: true,
    httpStatus: 200,
    components: { button: 'ok', layout: 'ok', dataPanel: 'ok', card: 'ok' },
  },
  storage: { ok: true },
};
const DEFAULT_SCENARIOS = [
  { id: 'button-handler-removed', label: 'Button handler removed', severity: 'high' },
  { id: 'card-layout-broken', label: 'Card layout broken', severity: 'medium' },
];

export class FakeApi {
  constructor({ port, dashboardOrigin }) {
    this.port = port;
    this.dashboardOrigin = dashboardOrigin;
    this.health = structuredClone(DEFAULT_HEALTH);
    this.scenarios = structuredClone(DEFAULT_SCENARIOS);
    this.incidents = [];
    this.verifications = {};
    this.events = [];
    this.nextSeq = 1;
    this.delays = { health: 0, snapshot: 0, chaos: 0, reset: 0 };
    this.forced = { chaos: null, reset: null };
    this.refuseStream = false;
    this.requests = [];
    this.streamConnections = [];
    this.streams = new Set();
    this.runCounter = 0;
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.sockets = new Set();
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve(this));
    });
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ----- test controls ---------------------------------------------------------------------

  setHealth(health) { this.health = structuredClone(health); }

  /** Adds an Incident record returned by GET /incidents and GET /incidents/:id. */
  addIncident(incident) { this.incidents.push(structuredClone(incident)); }

  /** Creates and stores a schema-valid Event, then writes it to every open SSE stream. Returns it. */
  pushEvent({ type, component = 'test-harness', incidentId = null, runId = null, payload = {} }) {
    const event = {
      id: randomUUID(),
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      type,
      component,
      incidentId,
      runId,
      payload,
    };
    assertValidEvent(event);
    this.nextSeq += 1;
    this.events.push(event);
    for (const res of this.streams) FakeApi.#writeEvent(res, event);
    return event;
  }

  /** Destroys every open SSE connection (a network loss as the browser sees it). */
  dropStreams() {
    for (const res of [...this.streams]) res.destroy();
    this.streams.clear();
  }

  forceError(endpoint, status, code, message, details) {
    this.forced[endpoint] = { status, body: { error: { code, message, ...(details ? { details } : {}) } } };
  }

  clearForced() { this.forced = { chaos: null, reset: null }; }

  requestsTo(method, suffix) {
    return this.requests.filter((r) => r.method === method && r.path === `${API}${suffix}`);
  }

  // ----- HTTP ------------------------------------------------------------------------------

  #cors(req, headers = {}) {
    const out = { Vary: 'Origin', ...headers };
    if (req.headers.origin === this.dashboardOrigin) out['Access-Control-Allow-Origin'] = this.dashboardOrigin;
    return out;
  }

  #json(req, res, status, body) {
    res.writeHead(status, this.#cors(req, { 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify(body));
  }

  #error(req, res, status, code, message, details) {
    this.#json(req, res, status, { error: { code, message, ...(details ? { details } : {}) } });
  }

  static #writeEvent(res, event) {
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    if (raw !== '') {
      try { body = JSON.parse(raw); } catch { body = undefined; }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ method: req.method, path: url.pathname, query, headers: req.headers, body, raw });

    if (req.method === 'OPTIONS') {
      if (req.headers.origin !== this.dashboardOrigin) {
        return this.#error(req, res, 403, 'origin_not_allowed', 'Origin not allowed.');
      }
      res.writeHead(204, this.#cors(req, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      }));
      return res.end();
    }

    const p = url.pathname;
    if (req.method === 'GET' && this.delays.snapshot && p !== `${API}/events/stream`) {
      await sleep(this.delays.snapshot); // delays every snapshot GET so the loading state is observable
    }
    if (req.method === 'GET' && p === `${API}/health`) {
      if (this.delays.health) await sleep(this.delays.health);
      return this.#json(req, res, 200, this.health);
    }
    if (req.method === 'GET' && p === `${API}/scenarios`) return this.#json(req, res, 200, { scenarios: this.scenarios });
    if (req.method === 'GET' && p === `${API}/incidents`) return this.#json(req, res, 200, { incidents: this.incidents });
    let m = p.match(new RegExp(`^${API}/incidents/([^/]+)/verification$`));
    if (req.method === 'GET' && m) {
      const id = decodeURIComponent(m[1]);
      if (!this.incidents.some((i) => i.incidentId === id)) return this.#error(req, res, 404, 'incident_not_found', 'No such Incident.');
      if (!this.verifications[id]) return this.#error(req, res, 404, 'verification_not_found', 'No Verification_Result yet.');
      return this.#json(req, res, 200, this.verifications[id]);
    }
    m = p.match(new RegExp(`^${API}/incidents/([^/]+)$`));
    if (req.method === 'GET' && m) {
      const found = this.incidents.find((i) => i.incidentId === decodeURIComponent(m[1]));
      return found ? this.#json(req, res, 200, found) : this.#error(req, res, 404, 'incident_not_found', 'No such Incident.');
    }
    if (req.method === 'GET' && p === `${API}/events`) {
      const after = query.afterSeq === undefined ? 0 : Number(query.afterSeq);
      if (!Number.isInteger(after) || after < 0) return this.#error(req, res, 400, 'invalid_query', 'afterSeq is invalid.');
      let events = this.events.filter((e) => e.seq > after);
      if (query.incidentId) events = events.filter((e) => e.incidentId === query.incidentId);
      return this.#json(req, res, 200, { events });
    }
    if (req.method === 'GET' && p === `${API}/events/stream`) return this.#stream(req, res, query);
    if (req.method === 'POST' && p === `${API}/chaos-runs`) return this.#chaos(req, res, body);
    if (req.method === 'POST' && p === `${API}/reset`) return this.#reset(req, res);
    return this.#error(req, res, 404, 'not_found', 'No such endpoint.');
  }

  #stream(req, res, query) {
    const afterSeq = query.afterSeq === undefined ? 0 : Number(query.afterSeq);
    const lastHeader = req.headers['last-event-id'];
    const lastEventId = lastHeader !== undefined && /^\d+$/.test(lastHeader) ? Number(lastHeader) : null;
    const resume = Math.max(Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0, lastEventId ?? 0);
    const log = { afterSeq: query.afterSeq === undefined ? null : afterSeq, lastEventId, resume, accepted: !this.refuseStream };
    this.streamConnections.push(log);
    if (this.refuseStream) return this.#error(req, res, 503, 'storage_error', 'Fake API: stream refused by the test.');
    res.writeHead(200, this.#cors(req, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    }));
    res.write('retry: 2000\n\n');
    for (const e of this.events) if (e.seq > resume) FakeApi.#writeEvent(res, e);
    this.streams.add(res);
    res.on('close', () => this.streams.delete(res));
  }

  async #chaos(req, res, body) {
    if (this.delays.chaos) await sleep(this.delays.chaos);
    if (this.forced.chaos) return this.#json(req, res, this.forced.chaos.status, this.forced.chaos.body);
    this.runCounter += 1;
    const scenarioId = body?.scenarioId ?? this.scenarios[0].id;
    this.#json(req, res, 202, { runId: `run-fake-${this.runCounter}`, scenarioId });
  }

  async #reset(req, res) {
    if (this.delays.reset) await sleep(this.delays.reset);
    if (this.forced.reset) return this.#json(req, res, this.forced.reset.status, this.forced.reset.body);
    this.#json(req, res, 200, {
      reset: true, snapshotId: 'snapshot-fake', checksums: {}, timestamp: new Date().toISOString(), eventId: randomUUID(),
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
