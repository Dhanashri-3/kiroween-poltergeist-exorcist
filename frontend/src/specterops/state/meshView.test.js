import { describe, it, expect } from 'vitest';
import { CARD_KEYS, MESH_CARDS, deriveMeshView, normalizeComponentHealth } from './meshView.js';

// Health shaped like the real Test_App response (testapp/health.js) as wrapped by the backend /health.
const realHealth = (components) => ({ status: 'degraded', testApp: { reachable: true, httpStatus: 200, components }, storage: { ok: true } });
const card = (view, key) => view.cards.find((c) => c.key === key);

describe('MESH_CARDS', () => {
  it('maps the four approved cards to the backend component keys', () => {
    expect(MESH_CARDS.map((c) => [c.name, c.key])).toEqual([
      ['Neural Core', 'dataPanel'], ['Edge Firewall', 'button'], ['Vault Auth', 'card'], ['System Layout', 'layout'],
    ]);
    expect(CARD_KEYS).toEqual(['dataPanel', 'button', 'card', 'layout']);
  });
});

describe('normalizeComponentHealth', () => {
  it('reads the real object shape and the fake string shape', () => {
    expect(normalizeComponentHealth({ button: { status: 'ok' } }, 'button')).toEqual({ status: 'ok', error: null });
    expect(normalizeComponentHealth({ button: { status: 'fail', error: 'no handler' } }, 'button')).toEqual({ status: 'fail', error: 'no handler' });
    expect(normalizeComponentHealth({ button: 'ok' }, 'button')).toEqual({ status: 'ok', error: null });
  });

  it('returns null status for anything it cannot read', () => {
    for (const components of [null, undefined, {}, { button: null }, { button: 42 }, { button: {} }, { button: '' }, 'ok']) {
      expect(normalizeComponentHealth(components, 'button').status).toBeNull();
    }
  });
});

describe('deriveMeshView', () => {
  it('shows every card as unavailable when no health has arrived', () => {
    const view = deriveMeshView({ health: null });
    expect(view.cards.map((c) => c.badge.text)).toEqual(['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE']);
    expect(view.cards.every((c) => c.health.note === 'No health data yet.' && !c.damaged && !c.verified)).toBe(true);
    expect(view.appLevel).toEqual([]);
  });

  it('distinguishes an unreachable Test_App and missing component health', () => {
    const unreachable = deriveMeshView({ health: { status: 'degraded', testApp: { reachable: false, components: null } } });
    expect(card(unreachable, 'button').health.note).toBe('Test_App unreachable.');
    const noComponents = deriveMeshView({ health: { status: 'ok', testApp: { reachable: true, components: null } } });
    expect(card(noComponents, 'button').health.note).toBe('Component health not reported.');
  });

  it('shows nominal, breached, unknown and unreported checks exactly as reported', () => {
    const view = deriveMeshView({
      health: realHealth({ dataPanel: { status: 'ok' }, button: { status: 'fail', error: 'onClick missing' }, card: { status: 'degraded' } }),
    });
    expect(card(view, 'dataPanel')).toMatchObject({ badge: { text: 'NOMINAL' }, damaged: false, health: { state: 'nominal', status: 'ok' } });
    expect(card(view, 'button')).toMatchObject({ badge: { text: 'BREACHED // FAULT' }, damaged: true, health: { state: 'breached', error: 'onClick missing' } });
    expect(card(view, 'card')).toMatchObject({ badge: { text: 'STATUS REPORTED' }, health: { state: 'unknown', status: 'degraded' } });
    expect(card(view, 'layout')).toMatchObject({ badge: { text: 'UNAVAILABLE' }, health: { state: 'unavailable', note: 'Not reported.' } });
  });

  it('accepts the fake string shape', () => {
    const view = deriveMeshView({ health: realHealth({ button: 'ok', card: 'fail' }) });
    expect(card(view, 'button').health.state).toBe('nominal');
    expect(card(view, 'card').health.state).toBe('breached');
  });

  it('shows PATCHED // VERIFIED only for a reducer-verified recovery', () => {
    const health = realHealth({ button: { status: 'ok' } });
    const outcomes = { recovered: 'PATCHED // VERIFIED', rolled_back: 'INCIDENT OPEN', escalated: 'ESCALATED', unverified_recovery_claim: 'INCIDENT OPEN', active: 'INCIDENT OPEN' };
    for (const [outcome, text] of Object.entries(outcomes)) {
      const view = deriveMeshView({ health, incidents: [{ incidentId: 'i1', component: 'button', outcome }] });
      expect(card(view, 'button').badge.text, outcome).toBe(text);
      expect(card(view, 'button').verified, outcome).toBe(outcome === 'recovered');
    }
  });

  it('lets a failing health check override a verified badge', () => {
    const view = deriveMeshView({ health: realHealth({ button: { status: 'fail' } }), incidents: [{ incidentId: 'i1', component: 'button', outcome: 'recovered' }] });
    expect(card(view, 'button').badge.text).toBe('BREACHED // FAULT');
    expect(card(view, 'button').incident.label).toBe('Verified recovery');
  });

  it('uses the newest Incident per card by lastSeq', () => {
    const view = deriveMeshView({
      incidents: [
        { incidentId: 'new', component: 'card', outcome: 'active', lastSeq: 30 },
        { incidentId: 'old', component: 'card', outcome: 'recovered', lastSeq: 10 },
      ],
    });
    expect(card(view, 'card').incident).toEqual({ incidentId: 'new', outcome: 'active', label: 'Incident open' });
  });

  it('separates app-level and unmapped Incidents instead of attaching them to a card', () => {
    const view = deriveMeshView({
      incidents: [
        { incidentId: 'a', component: 'app', outcome: 'active', lastSeq: 3 },
        { incidentId: 'b', component: null, outcome: 'none', lastSeq: 2 },
        { incidentId: 'c', component: 'header', outcome: 'escalated', lastSeq: 1 },
        { incidentId: 'd', component: 'button', outcome: 'active', lastSeq: 4 },
        { incidentId: '', component: 'button', outcome: 'active' },
        null,
      ],
    });
    expect(view.appLevel.map((i) => [i.incidentId, i.scope])).toEqual([
      ['a', 'Whole Test_App'], ['b', 'Component not reported yet'], ['c', 'Component header'],
    ]);
    expect(view.cards.filter((c) => c.incident).map((c) => c.incident.incidentId)).toEqual(['d']);
  });

  it('produces no invented metrics', () => {
    const view = deriveMeshView({ health: realHealth({ button: { status: 'ok' } }) });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/uptime|latency|%|\bms\b|load/i);
  });
});
