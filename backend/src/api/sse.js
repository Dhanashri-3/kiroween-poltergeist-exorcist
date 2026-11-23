// SSE event stream (Task 12.3; Requirements 14.3, 14.4, 14.5).
//
// createSseHandler({ eventLog }) returns the (req, res, next) handler mounted by createApiApp as
// GET /api/v1/events/stream.
//
// Ordering without duplicates or gaps:
//   1. subscribe to the Event_Log publisher first and buffer what arrives,
//   2. replay readAfter(lastSeq) in ascending order,
//   3. flush buffered events whose seq is greater than the last one written,
//   4. from then on write live events directly (still skipping seq <= last written).
// The Event_Log persists before it publishes (14.2), so an event is either in the replay read or
// published after the subscription; the seq check removes the overlap. Live events are written in the
// same tick they are published, which is well inside the 1 second bound (14.5).
//
// Resume point: the larger of the `afterSeq` query value and the `Last-Event-ID` header.
// The stream carries only the Dashboard view of the Event_Log. Payloads are passed through the Redactor.

import { redact } from '../events/redactor.js';

export const HEARTBEAT_MS = 15_000;
const SEQ_PATTERN = /^\d{1,15}$/;

const sendError = (res, status, code, message, details) =>
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });

/** Formats one SSE message. JSON.stringify never emits a raw newline, so one `data:` line is safe. */
export function formatSseEvent(event) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(redact(event))}\n\n`;
}

export function createSseHandler({ eventLog, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (typeof eventLog?.dashboardView !== 'function') {
    throw new TypeError('createSseHandler: eventLog.dashboardView is required');
  }

  return function sseHandler(req, res) {
    // ----- resume point -----------------------------------------------------------------------
    const rawAfter = req.query.afterSeq;
    if (rawAfter !== undefined && (typeof rawAfter !== 'string' || !SEQ_PATTERN.test(rawAfter))) {
      return sendError(res, 400, 'invalid_query', 'afterSeq must be a non-negative integer.', [
        { path: '/afterSeq', keyword: 'type', message: 'must be a non-negative integer' },
      ]);
    }
    const headerValue = req.get('last-event-id');
    // A malformed Last-Event-ID is ignored: the browser sets it, not the caller.
    const fromHeader = headerValue !== undefined && SEQ_PATTERN.test(headerValue.trim()) ? Number(headerValue.trim()) : 0;
    const fromQuery = rawAfter === undefined ? 0 : Number(rawAfter);
    let lastSent = Math.max(fromHeader, fromQuery);

    // ----- response ---------------------------------------------------------------------------
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    let closed = false;
    let live = false;
    const buffer = [];
    let unsubscribe = () => {};
    let heartbeat = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      buffer.length = 0;
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    const emit = (event) => {
      if (closed || event.seq <= lastSent) return;
      lastSent = event.seq;
      res.write(formatSseEvent(event));
    };

    const view = eventLog.dashboardView();

    // 1. subscribe first, buffering until the replay is done.
    unsubscribe = view.subscribe((event) => {
      if (closed) return;
      if (live) emit(event);
      else buffer.push(event);
    });
    if (closed) unsubscribe();

    heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    // 2-4. replay, flush buffer, go live.
    (async () => {
      const missed = await view.readAfter(lastSent);
      for (const event of missed) emit(event);
      buffer.sort((a, b) => a.seq - b.seq);
      for (const event of buffer) emit(event);
      buffer.length = 0;
      live = true;
    })().catch(() => {
      // The replay failed (for example a storage error). Close so the browser reconnects with its Last-Event-ID.
      cleanup();
      if (!res.writableEnded) res.end();
    });
    return undefined;
  };
}
