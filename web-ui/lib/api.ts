/**
 * Frontend -> backend hooks for the Poltergeist (chaos) and Exorcist (self-healing) agents.
 *
 * Interface the backend is expected to provide (agreed shape, not yet implemented server-side):
 *   POST {NEXT_PUBLIC_API_URL}/api/poltergeist   start a controlled failure injection
 *   POST {NEXT_PUBLIC_API_URL}/api/exorcist      start detection, repair and verification
 * Both are called without a request body or custom headers, so browsers send them as simple
 * requests (no CORS preflight). Any 2xx response counts as "accepted". The response body is
 * returned to the caller but is not interpreted yet.
 *
 * If NEXT_PUBLIC_API_URL is unset, or a request fails or exceeds 3000 ms, the helpers resolve
 * to { ok: false } and never throw, so the UI can fall back to its local simulation.
 *
 * NEXT_PUBLIC_* values are bundled into the browser, so only put a URL here, never a secret.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

const TIMEOUT_MS = 3000;

export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: "not-configured" | "timeout" | "network" | "http" };

async function post(path: string): Promise<ApiResult> {
  if (!API_BASE) return { ok: false, reason: "not-configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: "POST", signal: controller.signal });
    if (!res.ok) return { ok: false, reason: "http" };
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // An empty or non-JSON body is fine; the request itself succeeded.
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the backend to start the Poltergeist (chaos) agent. */
export function triggerPoltergeist(): Promise<ApiResult> {
  return post("/api/poltergeist");
}

/** Ask the backend to start the Exorcist (detect, repair, verify) agent. */
export function triggerExorcist(): Promise<ApiResult> {
  return post("/api/exorcist");
}
