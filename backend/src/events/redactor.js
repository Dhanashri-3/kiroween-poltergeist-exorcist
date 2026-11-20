// Redactor (Task 3.4, Requirements 13.6 and 17.3).
// redact(value) returns a deep copy of value in which Secret patterns are replaced and content
// belonging to denylisted files (.env*, .git/) is refused. The input is never mutated.

export const REDACTED = '[REDACTED]';
export const REFUSED = '[REFUSED: denylisted file]';

const PATH_KEYS = new Set(['path', 'file', 'filename', 'filepath', 'file_path', 'relativepath', 'source']);

// Order matters: structured patterns run before the generic ones.
const SECRET_PATTERNS = [
  // PEM private key blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: REDACTED },
  // Authorization / bearer tokens
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  { re: /\b(Basic)\s+[A-Za-z0-9+/=]{8,}/g, replace: `$1 ${REDACTED}` },
  // Well-known API key shapes
  { re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: REDACTED },
  { re: /\bAIza[A-Za-z0-9_-]{30,}/g, replace: REDACTED },
  { re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // .env-style assignments with a sensitive-looking name: KEY=value, KEY: value, "key": "value"
  {
    re: /(["']?\b[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*\b["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;&]+)/gi,
    replace: `$1${REDACTED}`
  },
  // Generic .env-style assignment lines: UPPER_CASE_NAME=value at the start of a line
  { re: /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*)(?!\[REDACTED\])\S.*$/gm, replace: `$1${REDACTED}` }
];

/** True when the path names a .env* file or anything under a .git directory (case-insensitive). */
export function isDenylistedPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const segments = candidate.replace(/\\/g, '/').toLowerCase().split('/').filter((s) => s !== '');
  if (segments.length === 0) return false;
  if (segments.slice(0, -1).includes('.git') || segments[segments.length - 1] === '.git') return true;
  return segments[segments.length - 1].startsWith('.env');
}

function redactString(text) {
  if (isDenylistedPath(text.trim()) && !/\s/.test(text.trim())) return REFUSED;
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

function hasDenylistedPathField(obj) {
  for (const [key, val] of Object.entries(obj)) {
    if (PATH_KEYS.has(key.toLowerCase()) && typeof val === 'string' && isDenylistedPath(val)) return true;
  }
  return false;
}

function walk(value, seen) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return REDACTED; // circular reference
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => walk(item, seen));
  } else if (value instanceof Date) {
    result = new Date(value.getTime());
  } else if (hasDenylistedPathField(value)) {
    result = REFUSED;
  } else {
    result = {};
    for (const [key, val] of Object.entries(value)) {
      // A denylisted file name used as a key (e.g. { ".env": "..." }) is refused entirely.
      if (isDenylistedPath(key)) result[REFUSED] = REFUSED;
      else result[redactString(key)] = walk(val, seen);
    }
  }
  seen.delete(value);
  return result;
}

/**
 * Deep-redact a value. Strings, arrays and plain objects are handled recursively; the input is
 * not mutated. Objects that reference a denylisted file via a path-like field are replaced
 * wholesale by REFUSED.
 */
export function redact(value) {
  return walk(value, new Set());
}
