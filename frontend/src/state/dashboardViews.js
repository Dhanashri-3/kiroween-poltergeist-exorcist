/**
 * Small view selectors for the Dashboard (task 14.6). Pure, derived from reducer state only.
 * They add no outcome logic: outcomes come from selectIncidentOutcome in dashboardReducer.js.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Events of one Incident, ascending by seq (the timeline is already sorted). */
export function selectIncidentEvents(state, incidentId) {
  return state.events.filter((e) => e.incidentId === incidentId);
}

/** Evidence references recorded on the API Incident. The API has no endpoint for Evidence bodies. */
export function selectIncidentEvidenceRefs(state, incidentId) {
  const refs = state.apiIncidents[incidentId]?.evidenceRefs;
  return Array.isArray(refs) ? refs.filter((r) => typeof r === 'string' && r !== '') : [];
}

/**
 * `{ref, bytes}` is the documented "payload omitted" form (docs/event-schema.md, 64 KB rule).
 * Returns the byte count, or null when the payload is not of that form.
 */
export function omittedPayloadBytes(payload) {
  if (!isObject(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length === 2 && keys.includes('ref') && keys.includes('bytes') &&
      typeof payload.ref === 'string' && Number.isInteger(payload.bytes) && payload.bytes >= 0) {
    return payload.bytes;
  }
  return null;
}

const str = (v) => (typeof v === 'string' ? v : null);

/** snapshotChecksums as [{path, checksum}] (the documented form); anything else gives []. */
function snapshotChecksumList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((c) => isObject(c) && typeof c.path === 'string' && typeof c.checksum === 'string')
    .map((c) => ({ path: c.path, checksum: c.checksum }));
}

/**
 * The repair record, from the highest-seq `repair` Event of the Incident (null when there is none).
 * Documented repair payload: { incidentId, target, snapshotId, preChecksum, postChecksum, snapshotChecksums }.
 * The repair Event carries checksums only, never changed content. `checksumsDiffer` is computed only from
 * the two strings (null when either is missing).
 *
 * `preview` is NOT a diff of the file. It is what the Repair_Plan specified: change.find / change.replace of
 * the latest non-rejected `plan` Event with seq below the repair seq. It is null when that plan lacks string
 * find and replace. `preview.targetMismatch` is true when the plan's targetFile differs from the repair target.
 */
export function selectRepairView(state, incidentId) {
  const events = selectIncidentEvents(state, incidentId);
  let repair = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'repair') { repair = events[i]; break; }
  }
  if (repair === null) return null;
  const bytes = omittedPayloadBytes(repair.payload);
  if (bytes !== null) return { omitted: true, bytes };
  const p = isObject(repair.payload) ? repair.payload : {};
  const target = str(p.target);
  const preChecksum = str(p.preChecksum);
  const postChecksum = str(p.postChecksum);

  let preview = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type !== 'plan' || e.seq >= repair.seq) continue;
    const payload = isObject(e.payload) ? e.payload : {};
    if (payload.rejected === true) continue;
    const plan = isObject(payload.plan) ? payload.plan : {};
    const change = isObject(plan.change) ? plan.change : null;
    if (change && typeof change.find === 'string' && typeof change.replace === 'string') {
      const planTarget = str(plan.targetFile);
      preview = {
        find: change.find,
        replace: change.replace,
        planSeq: e.seq,
        planTarget,
        targetMismatch: planTarget !== null && target !== null && planTarget !== target,
      };
    }
    break;
  }
  return {
    omitted: false,
    target,
    snapshotId: str(p.snapshotId),
    preChecksum,
    postChecksum,
    checksumsDiffer: preChecksum !== null && postChecksum !== null ? preChecksum !== postChecksum : null,
    snapshotChecksums: snapshotChecksumList(p.snapshotChecksums),
    preview,
  };
}
