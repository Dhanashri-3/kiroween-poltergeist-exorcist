/** Jagged, deterministic lightning polyline between two points (ported from web-ui jaggedPath). */
export function jaggedPath(a, b, seed) {
  const segments = 12;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  let state = (Math.abs(Math.trunc(seed)) % 233280) * 9301 + 49297;
  const rnd = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280 - 0.5;
  };
  let d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}`;
  for (let i = 1; i < segments; i += 1) {
    const t = i / segments;
    const off = rnd() * 36 * Math.sin(Math.PI * t);
    d += ` L${(a.x + dx * t + nx * off).toFixed(1)} ${(a.y + dy * t + ny * off).toFixed(1)}`;
  }
  return `${d} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/** Electrified violet plasma ray from the scythe tip to the target card. Decorative. */
export default function PlasmaBeam({ from, to, seed = 1 }) {
  const main = jaggedPath(from, to, seed);
  const fork = jaggedPath(from, to, seed + 7);
  return (
    <svg className="so-beam" aria-hidden="true" focusable="false" data-testid="so-beam">
      <g className="so-beam__flicker">
        <path d={main} pathLength="1" className="so-beam__halo" />
        <path d={main} pathLength="1" className="so-beam__body" />
        <path d={fork} pathLength="1" className="so-beam__fork" />
        <path d={main} pathLength="1" className="so-beam__core" />
      </g>
    </svg>
  );
}
