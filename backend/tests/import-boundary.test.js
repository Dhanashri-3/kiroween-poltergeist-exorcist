// Task 1.4: module import-boundary check.
// Rules (design.md "Project layout", Storage Interface section):
//  - backend/src/poltergeist/ and backend/src/exorcist/ may import only: Node built-ins,
//    external packages, backend/src/contracts/, and files inside their own directory.
//  - Neither agent may import the other, the storage module (local JSON implementation),
//    or any other internal module.
//  - frontend/ may not import anything from backend/.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export function makeLayout(repoRoot) {
  const backend = path.join(repoRoot, 'backend');
  const src = path.join(backend, 'src');
  return {
    repoRoot,
    backend,
    src,
    frontend: path.join(repoRoot, 'frontend'),
    contracts: path.join(src, 'contracts'),
    storage: path.join(src, 'storage'),
    storageData: path.join(backend, 'storage-data'),
    agents: { poltergeist: path.join(src, 'poltergeist'), exorcist: path.join(src, 'exorcist') }
  };
}

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
// First path segments that identify project-internal modules when written as bare specifiers.
const INTERNAL_BARE_ROOTS = new Set([
  'backend', 'frontend', 'testapp', 'src', 'contracts', 'storage', 'storage-data', 'poltergeist',
  'exorcist', 'orchestrator', 'api', 'scenario-engine', 'monitor', 'incident', 'safety-gate',
  'repair-executor', 'verification', 'events', 'file-guard'
]);

/**
 * Replace comments with spaces (keeping offsets) and return a mask where mask[i] is true only
 * for characters that are real code (not inside a comment, string or template literal body).
 * Quote characters themselves count as code so the specifier literal can be matched.
 */
export function maskSource(source) {
  const n = source.length;
  const out = source.split('');
  const code = new Array(n).fill(true);
  let i = 0;
  const blank = (from, to, keepNewlines = true) => {
    for (let k = from; k < to; k++) {
      code[k] = false;
      if (!(keepNewlines && source[k] === '\n')) out[k] = ' ';
    }
  };
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = source.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      // contents are not code, but keep text so the literal can be read back
      for (let k = i + 1; k < Math.min(j, n); k++) code[k] = false;
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      while (j < n && source[j] !== '`') j += source[j] === '\\' ? 2 : 1;
      for (let k = i + 1; k < Math.min(j, n); k++) code[k] = false;
      i = j + 1;
    } else {
      i++;
    }
  }
  return { text: out.join(''), code };
}

const PATTERNS = [
  { kind: 'import', re: /\bimport\s+(?:[^'"`;()]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g },
  { kind: 'export-from', re: /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g },
  { kind: 'dynamic-import', re: /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g },
  { kind: 'require', re: /(?<![.\w$])require\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g }
];

/** Extract import specifiers from JS source, ignoring comments and string contents. */
export function extractSpecifiers(source) {
  const { text, code } = maskSource(source);
  const found = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!code[m.index]) continue; // keyword sits inside a string/comment
      found.push({ kind, specifier: m[2] });
    }
  }
  return found;
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Which area does a file belong to: 'poltergeist' | 'exorcist' | 'frontend' | null. */
function ownerOf(filePath, layout) {
  for (const [name, dir] of Object.entries(layout.agents)) if (isInside(filePath, dir)) return name;
  if (isInside(filePath, layout.frontend)) return 'frontend';
  return null;
}

/** Returns a list of violation strings for one file. */
export function analyzeSource(source, filePath, layout) {
  const owner = ownerOf(filePath, layout);
  if (!owner) return [];
  const violations = [];
  const fileDir = path.dirname(filePath);

  for (const { kind, specifier } of extractSpecifiers(source)) {
    const where = `${path.relative(layout.repoRoot, filePath)}: ${kind} '${specifier}'`;
    const bare = specifier.replace(/^node:/, '');
    if (specifier.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0])) continue;

    let target = null;
    if (specifier.startsWith('file:')) {
      try { target = fileURLToPath(specifier); } catch { violations.push(`${where} -> unparseable file URL`); continue; }
    } else if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      target = path.resolve(fileDir, specifier);
    } else {
      const root = specifier.split('/')[0];
      if (INTERNAL_BARE_ROOTS.has(root)) {
        violations.push(`${where} -> internal module referenced by bare path`);
      }
      continue; // otherwise an external package
    }

    if (owner === 'frontend') {
      if (isInside(target, layout.backend)) violations.push(`${where} -> frontend must not import from backend/`);
      continue;
    }

    // Agent directories.
    const other = owner === 'poltergeist' ? 'exorcist' : 'poltergeist';
    if (isInside(target, layout.agents[other])) {
      violations.push(`${where} -> ${owner} must not import ${other}/`);
    } else if (isInside(target, layout.storage) || isInside(target, layout.storageData)) {
      violations.push(`${where} -> agents must not import the local JSON storage implementation`);
    } else if (isInside(target, layout.agents[owner]) || isInside(target, layout.contracts)) {
      continue;
    } else {
      violations.push(`${where} -> agents may import only contracts/ (or their own directory)`);
    }
  }
  return violations;
}

const SOURCE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

export function listSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...listSourceFiles(full));
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

export function scanLayout(layout) {
  const roots = [layout.agents.poltergeist, layout.agents.exorcist, layout.frontend];
  const violations = [];
  for (const file of roots.flatMap(listSourceFiles)) {
    violations.push(...analyzeSource(fs.readFileSync(file, 'utf8'), file, layout));
  }
  return violations;
}

// ---------------------------------------------------------------------------

describe('repository import boundaries', () => {
  it('has no violations in backend/src/poltergeist, backend/src/exorcist or frontend', () => {
    expect(scanLayout(makeLayout(REPO_ROOT))).toEqual([]);
  });
});

describe('import-boundary analyzer', () => {
  const L = makeLayout(path.resolve('/virtual-repo'));
  const polt = path.join(L.agents.poltergeist, 'agent.js');
  const exor = path.join(L.agents.exorcist, 'nested', 'agent.js');
  const front = path.join(L.frontend, 'src', 'App.jsx');
  const check = (src, file) => analyzeSource(src, file, L);

  it('allows node built-ins, external packages, contracts and own-directory imports', () => {
    const src = `
      import fs from 'node:fs';
      import path from 'path';
      import { readFile } from 'fs/promises';
      import Ajv from 'ajv';
      import { validate } from '../contracts/index.js';
      import helper from './helper.js';
      export { x } from './own.js';
    `;
    expect(check(src, polt)).toEqual([]);
    expect(check(`import a from '../../contracts/index.js'; import b from '../helper.js';`, exor)).toEqual([]);
  });

  it('rejects poltergeist -> exorcist and exorcist -> poltergeist', () => {
    expect(check(`import x from '../exorcist/a.js';`, polt)).toHaveLength(1);
    expect(check(`import x from '../../poltergeist/a.js';`, exor)).toHaveLength(1);
  });

  it('rejects other internal backend modules', () => {
    expect(check(`import x from '../safety-gate/gate.js';`, polt)).toHaveLength(1);
    expect(check(`import x from '../events/log.js';`, polt)).toHaveLength(1);
    expect(check(`import x from '../../../frontend/a.js';`, polt)).toHaveLength(1);
  });

  it('rejects direct storage imports by relative path, absolute path, file URL and bare path', () => {
    const storageFile = path.join(L.storage, 'json-store.js');
    expect(check(`import s from '../storage/json-store.js';`, polt)).toHaveLength(1);
    expect(check(`import s from '${storageFile.replace(/\\/g, '/')}';`, polt)).toHaveLength(1);
    expect(check(`import s from '${pathToFileURL(storageFile).href}';`, exor)).toHaveLength(1);
    expect(check(`import s from 'backend/src/storage/json-store.js';`, exor)).toHaveLength(1);
    expect(check(`import s from '../../../storage-data/events.json';`, exor)).toHaveLength(1);
  });

  it('covers static, export-from, dynamic import() and require()', () => {
    const bad = '../exorcist/x.js';
    expect(check(`import '${bad}';`, polt)).toHaveLength(1);
    expect(check(`import * as ns from '${bad}';`, polt)).toHaveLength(1);
    expect(check(`import {\n a,\n b as c\n} from '${bad}';`, polt)).toHaveLength(1);
    expect(check(`export * from '${bad}';`, polt)).toHaveLength(1);
    expect(check(`export * as ns from '${bad}';`, polt)).toHaveLength(1);
    expect(check(`export { a } from '${bad}';`, polt)).toHaveLength(1);
    expect(check(`const m = await import('${bad}');`, polt)).toHaveLength(1);
    expect(check(`const m = require('${bad}');`, polt)).toHaveLength(1);
    expect(check('const m = await import(`' + bad + '`);', polt)).toHaveLength(1);
  });

  it('resolves paths instead of matching substrings', () => {
    // Contains "exorcist" textually but resolves back into the poltergeist directory.
    expect(check(`import x from '../exorcist/../poltergeist/a.js';`, polt)).toEqual([]);
    // Resolves into exorcist even though the text never says "exorcist/" after a plain prefix.
    expect(check(`import x from './../exorcist/./a.js';`, polt)).toHaveLength(1);
    // A sibling directory that merely shares a prefix is not the exorcist directory.
    expect(check(`import x from '../exorcist-notes/a.js';`, polt)).toHaveLength(1); // other internal, still rejected
    expect(check(`import x from 'exorcist-lib';`, polt)).toEqual([]); // external package, not internal
  });

  it('ignores comments and unrelated strings', () => {
    const src = `
      // import x from '../exorcist/a.js';
      /* import y from '../exorcist/b.js';
         const z = require('../storage/s.js'); */
      const a = "import q from '../exorcist/c.js'";
      const b = 'require("../storage/d.js")';
      const c = \`import('../exorcist/e.js')\`;
      const url = 'http://example.com//import x from "../exorcist/f.js"';
      const ok = 1; // trailing import z from '../exorcist/g.js'
    `;
    expect(check(src, polt)).toEqual([]);
  });

  it('does not treat member calls named require/import as imports', () => {
    expect(check(`obj.require('../exorcist/a.js'); const importer = 1;`, polt)).toEqual([]);
  });

  it('rejects frontend imports from backend and allows frontend-internal/external imports', () => {
    expect(check(`import x from '../../backend/src/contracts/index.js';`, front)).toHaveLength(1);
    expect(check(`const m = import('../../backend/src/api/a.js');`, front)).toHaveLength(1);
    expect(check(`import x from 'backend/src/api/a.js';`, front)).toHaveLength(1);
    expect(check(`import React from 'react'; import a from './components/A.jsx';`, front)).toEqual([]);
  });

  it('ignores files outside the governed directories', () => {
    expect(check(`import x from '../exorcist/a.js';`, path.join(L.src, 'orchestrator', 'o.js'))).toEqual([]);
  });
});

describe('filesystem scan on a fixture tree', () => {
  it('finds violations in nested files and skips node_modules', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-'));
    try {
      const L = makeLayout(tmp);
      const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
      w(path.join(L.agents.poltergeist, 'ok.js'), `import a from '../contracts/index.js';`);
      w(path.join(L.agents.poltergeist, 'deep', 'bad.js'), `import s from '../../storage/json.js';`);
      w(path.join(L.agents.poltergeist, 'node_modules', 'x', 'i.js'), `import s from '../../../exorcist/a.js';`);
      w(path.join(L.agents.exorcist, 'bad.mjs'), `import p from '../poltergeist/ok.js';`);
      w(path.join(L.frontend, 'src', 'bad.jsx'), `import b from '../../backend/src/api/x.js';`);
      const violations = scanLayout(L);
      expect(violations).toHaveLength(3);
      expect(violations.join('\n')).toMatch(/storage/);
      expect(violations.join('\n')).toMatch(/must not import poltergeist/);
      expect(violations.join('\n')).toMatch(/frontend must not import from backend/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
