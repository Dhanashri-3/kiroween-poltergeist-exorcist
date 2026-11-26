import { CARD_KEYS } from './meshView.js';

/**
 * Live visual effects derived from genuine Events (Phase 4B.3B). Pure.
 *
 * Only Events with seq > watermark count. Events present before the watermark are history and never
 * replay an effect. With watermark null nothing is live.
 *
 *   strike  { targetKey, token } from the newest live `chaos.injection` whose payload.targetComponent is a
 *           Defense Mesh key. It ends at a later live `reset` Event, or at a later live terminal
 *           `incident.state` (recovered/escalated) for an Incident whose component is the target.
 *   heal    { targetKey, token } from the newest live `incident.state` -> recovered, but only when the
 *           reducer outcome for that Incident is `recovered` (passing verification) and its component is
 *           a Defense Mesh key. `rolled_back` and `escalated` never heal.
 *
 * incidents: [{ incidentId, component, outcome }] as passed to deriveMeshView.
 */
const TERMINAL = new Set(['recovered', 'escalated']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deriveLiveEffects({ events = [], watermark = null, incidents = [] } = {}) {
  if (!Number.isInteger(watermark)) return { strike: null, heal: null };
  const byId = new Map();
  for (const i of Array.isArray(incidents) ? incidents : []) {
    if (isObject(i) && typeof i.incidentId === 'string') byId.set(i.incidentId, i);
  }
  const live = (Array.isArray(events) ? events : []).filter((e) => isObject(e) && Number.isInteger(e.seq) && e.seq > watermark);

  let strike = null;
  let heal = null;
  for (const e of live) {
    const p = isObject(e.payload) ? e.payload : {};
    if (e.type === 'chaos.injection') {
      strike = CARD_KEYS.includes(p.targetComponent) ? { targetKey: p.targetComponent, token: e.seq } : null;
      continue;
    }
    if (e.type === 'reset') {
      strike = null;
      continue;
    }
    if (e.type === 'incident.state' && TERMINAL.has(p.to)) {
      const incident = byId.get(e.incidentId);
      const component = incident?.component ?? null;
      if (strike && component === strike.targetKey) strike = null;
      if (p.to === 'recovered' && incident?.outcome === 'recovered' && CARD_KEYS.includes(component)) {
        heal = { targetKey: component, token: e.seq };
      }
    }
  }
  return { strike, heal };
}
