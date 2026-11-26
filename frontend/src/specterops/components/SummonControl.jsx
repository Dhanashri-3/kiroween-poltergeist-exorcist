/**
 * Presentational "Summon Poltergeist" control (Phase 4B.3B).
 *
 * It calls `onSummon()` and shows what the caller passes in. It holds no request state and never decides
 * that anything succeeded: `notice` and `error` are supplied by the caller (Phase 4B.3C wires the shared
 * chaos guard). Without `onSummon` the button is disabled.
 *
 * Props: onSummon, busy, disabled, notice (string|null), error (string|null).
 */
export default function SummonControl({ onSummon, busy = false, disabled = false, notice = null, error = null }) {
  const unavailable = typeof onSummon !== 'function';
  const off = busy || disabled || unavailable;
  return (
    <div className="so-summon">
      <button type="button" className="so-summon__btn" disabled={off} aria-busy={busy || undefined}
        aria-describedby="so-summon-feedback" onClick={() => { if (!off) onSummon(); }}>
        {busy ? 'Summoning…' : 'Summon Poltergeist'}
      </button>
      <div id="so-summon-feedback" className="so-summon__feedback" aria-live="polite">
        {error ? <p className="so-summon__error" role="alert">{error}</p> : null}
        {!error && notice ? <p className="so-summon__notice">{notice}</p> : null}
      </div>
    </div>
  );
}
