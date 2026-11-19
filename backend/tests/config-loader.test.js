// Task 2.2: configuration files, loader and path safety.
// Invalid cases use temporary copies of config/ and testapp/; real files are never modified.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  loadConfig,
  initializeConfig,
  ConfigError,
  CONFIG_FILES,
  DEFAULT_CONFIG_DIR,
  DEFAULT_TESTAPP_DIR,
  REQUIRED_SCENARIO_IDS,
  COMPONENT_IDS,
  PINNED_COMMAND_TEMPLATES,
  HEALTH_CHECK_SCRIPT,
  HEALTH_CHECK_SCRIPT_SHA256,
  changedLines,
  fallbackEntryMatchesEvidence,
} from '../src/orchestrator/config-loader.js';
import {
  checkRelativePathSyntax,
  resolveApprovedFile,
  checkSensitiveFile,
  actionFileCompatible,
} from '../src/file-guard/path-safety.js';

// Link-creation capability probes. Tests that need a link are reported as skipped (never silently
// passed) when the platform or privileges do not allow creating one.
function canCreateLink(type) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-probe-'));
  try {
    const target = path.join(dir, type === 'file' ? 'target.txt' : 'target');
    if (type === 'file') fs.writeFileSync(target, 'x'); else fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dir, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const CAN_JUNCTION = canCreateLink('junction'); // a directory symlink on POSIX
const CAN_FILE_SYMLINK = canCreateLink('file');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
  tmpDirs.push(root);
  const configDir = path.join(root, 'config');
  const testappDir = path.join(root, 'testapp');
  fs.cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
  fs.cpSync(DEFAULT_TESTAPP_DIR, testappDir, { recursive: true });
  const load = () => loadConfig({ configDir, testappDir });
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
  const writeJson = (name, value) => fs.writeFileSync(path.join(configDir, name), JSON.stringify(value, null, 2));
  const edit = (name, fn) => { const doc = readJson(name); fn(doc); writeJson(name, doc); };
  return { root, configDir, testappDir, load, readJson, writeJson, edit };
}

const codes = (result) => (result.ok ? [] : result.errors.map((e) => e.code));
const hasCode = (result, code, file) =>
  !result.ok && result.errors.some((e) => e.code === code && (file === undefined || e.file === file));

describe('shipped configuration', () => {
  it('loads and validates against the real testapp', () => {
    const result = loadConfig();
    expect(result.errors).toBeUndefined();
    expect(result.ok).toBe(true);
    const { config } = result;
    expect(config.approvedFiles.length).toBeGreaterThan(0);
    expect(config.actionAllowlist.map((a) => a.actionType).sort()).toEqual(
      ['replace_mock_api_handler', 'replace_style_rule', 'replace_text']
    );
    expect(config.commandTemplates.map((t) => t.templateId).sort()).toEqual(['Health_Check', 'Playwright', 'Vitest']);
  });

  it('every approved file exists inside the real testapp directory', () => {
    const { config } = loadConfig();
    for (const rel of config.approvedFiles) {
      const r = resolveApprovedFile(DEFAULT_TESTAPP_DIR, rel);
      expect(r.ok, rel).toBe(true);
    }
  });

  it('contains exactly the six required scenarios with all required fields', () => {
    const { config } = loadConfig();
    const ids = config.scenarioCatalog.map((s) => s.scenarioId);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort()).toEqual([...REQUIRED_SCENARIO_IDS].sort());
    for (const s of config.scenarioCatalog) {
      for (const field of ['label', 'targetComponent', 'severity', 'targetFiles', 'injection', 'reversal', 'expectedRepairAction']) {
        expect(s[field], `${s.scenarioId}.${field}`).toBeTruthy();
      }
      expect(COMPONENT_IDS).toContain(s.targetComponent);
      for (const f of s.targetFiles) expect(config.approvedFiles).toContain(f);
    }
  });

  it('fallback mapping is evidence-pattern based and holds no scenario IDs', () => {
    const { config } = loadConfig();
    const text = JSON.stringify(config.fallbackMapping).toLowerCase();
    for (const id of REQUIRED_SCENARIO_IDS) expect(text).not.toContain(id);
    expect(text).not.toMatch(/scenario/);
    expect(config.fallbackMapping.length).toBeGreaterThanOrEqual(6);
    for (const e of config.fallbackMapping) {
      expect(e.evidencePattern.errorPattern).toBeTruthy();
      expect(() => new RegExp(e.evidencePattern.errorPattern)).not.toThrow();
    }
  });

  it('command templates are fixed node invocations restricted to the component enum', () => {
    const { config } = loadConfig();
    for (const t of config.commandTemplates) {
      expect(t.executable).toBe('node');
      expect([...t.allowedParams].sort()).toEqual([...COMPONENT_IDS].sort());
    }
  });
});

describe('missing, malformed and schema-invalid files', () => {
  it.each(Object.values(CONFIG_FILES))('refuses when %s is missing', (name) => {
    const fx = makeFixture();
    fs.rmSync(path.join(fx.configDir, name));
    const r = fx.load();
    expect(r.ok).toBe(false);
    expect(hasCode(r, 'missing_file', name)).toBe(true);
  });

  it.each(Object.values(CONFIG_FILES))('refuses malformed JSON in %s', (name) => {
    const fx = makeFixture();
    fs.writeFileSync(path.join(fx.configDir, name), '{ "version": ');
    const r = fx.load();
    expect(hasCode(r, 'malformed_json', name)).toBe(true);
  });

  it('refuses when a scenario entry violates the contract schema', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { delete d.scenarios[0].severity; });
    expect(hasCode(fx.load(), 'schema_invalid', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses when an allowlist entry violates the contract schema', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { delete d[0].maxChangedLines; });
    expect(hasCode(fx.load(), 'schema_invalid', 'action-allowlist.json')).toBe(true);
  });

  it('refuses when a command template violates the contract schema', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[1].timeoutMs = 'soon'; });
    expect(hasCode(fx.load(), 'schema_invalid', 'command-templates.json')).toBe(true);
  });

  it('refuses when a fallback mapping entry violates the contract schema', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { delete d.entries[0].planTemplate; });
    expect(hasCode(fx.load(), 'schema_invalid', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses a wrong top-level shape', () => {
    const fx = makeFixture();
    fx.writeJson('approved-files.json', ['mock-api.js']);
    expect(hasCode(fx.load(), 'schema_invalid', 'approved-files.json')).toBe(true);
  });
});

describe('complete document schemas', () => {
  const docs = [
    ['approved-files.json', 'files'],
    ['scenario-catalog.json', 'scenarios'],
    ['command-templates.json', 'templates'],
    ['fallback-mapping.json', 'entries'],
  ];

  it.each(docs)('%s: refuses a missing version', (name) => {
    const fx = makeFixture();
    fx.edit(name, (d) => { delete d.version; });
    expect(hasCode(fx.load(), 'schema_invalid', name)).toBe(true);
  });

  it.each(docs)('%s: refuses an empty or non-string version', (name) => {
    const fx = makeFixture();
    fx.edit(name, (d) => { d.version = ''; });
    expect(hasCode(fx.load(), 'schema_invalid', name)).toBe(true);
    const fx2 = makeFixture();
    fx2.edit(name, (d) => { d.version = 1; });
    expect(hasCode(fx2.load(), 'schema_invalid', name)).toBe(true);
  });

  it.each(docs)('%s: refuses an extra top-level key', (name) => {
    const fx = makeFixture();
    fx.edit(name, (d) => { d.extra = true; });
    const r = fx.load();
    expect(r.errors.some((e) => e.file === name && e.code === 'schema_invalid' && e.keyword === 'additionalProperties')).toBe(true);
  });

  it.each(docs)('%s: refuses a wrong type for its list', (name, key) => {
    const fx = makeFixture();
    fx.edit(name, (d) => { d[key] = 'not-a-list'; });
    expect(hasCode(fx.load(), 'schema_invalid', name)).toBe(true);
  });

  it('refuses an empty approved-files list and an empty fallback entries list', () => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files = []; });
    fx.edit('fallback-mapping.json', (d) => { d.entries = []; });
    const r = fx.load();
    expect(hasCode(r, 'schema_invalid', 'approved-files.json')).toBe(true);
    expect(hasCode(r, 'schema_invalid', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses a scenario entry with a bad enum or an unknown key', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].severity = 'apocalyptic'; d.scenarios[1].extra = 1; });
    const r = fx.load();
    expect(r.errors.filter((e) => e.code === 'schema_invalid').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a malformed transform object', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].injection = 'replace the handler'; });
    expect(hasCode(fx.load(), 'schema_invalid', 'scenario-catalog.json')).toBe(true);
    const fx2 = makeFixture();
    fx2.edit('scenario-catalog.json', (d) => { d.scenarios[0].injection.steps[0].extra = 1; });
    expect(hasCode(fx2.load(), 'schema_invalid', 'scenario-catalog.json')).toBe(true);
  });
});

describe('path safety', () => {
  const unsafe = [
    '../backend/package.json',
    'public/../../backend/package.json',
    'public/../mock-api.js',
    './mock-api.js',
    '/etc/passwd',
    'C:/Windows/system.ini',
    'C:\\Windows\\system.ini',
    'c:mock-api.js',
    '//server/share/file.js',
    '\\\\server\\share\\file.js',
    'public\\button.js',
    'public//button.js',
    'public/',
    'mock-api.js\0.txt',
    'mock-api.js ',
    ' mock-api.js',
    'mock-api.js.',
    'mock-api.js::$DATA',
    'public/*.js',
    '',
    42,
    null,
  ];

  it.each(unsafe.map((p) => [JSON.stringify(p), p]))('syntax check rejects %s', (_label, p) => {
    expect(checkRelativePathSyntax(p).ok).toBe(false);
  });

  it('syntax check accepts plain relative forward-slash paths', () => {
    expect(checkRelativePathSyntax('public/button.js').ok).toBe(true);
    expect(checkRelativePathSyntax('mock-api.js').ok).toBe(true);
  });

  it.each(unsafe.filter((p) => typeof p === 'string' && p !== '').map((p) => [JSON.stringify(p), p]))(
    'loader refuses approved path %s',
    (_label, p) => {
      const fx = makeFixture();
      fx.edit('approved-files.json', (d) => { d.files.push(p); });
      const r = fx.load();
      expect(r.ok).toBe(false);
      expect(hasCode(r, 'unsafe_path', 'approved-files.json')).toBe(true);
    }
  );

  it('distinguishes file_not_found (reason not_found) from unsafe_path (reason traversal)', () => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push('public/missing.js', '../outside.js'); });
    const r = fx.load();
    const missing = r.errors.find((e) => e.code === 'file_not_found');
    const unsafe = r.errors.find((e) => e.code === 'unsafe_path');
    expect(missing).toMatchObject({ file: 'approved-files.json', reason: 'not_found' });
    expect(unsafe).toMatchObject({ file: 'approved-files.json', reason: 'traversal' });
    expect(r.errors.filter((e) => e.code === 'file_not_found')).toHaveLength(1);
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', { path: 'mock-api.js' }],
    ['an array', ['mock-api.js']],
    ['a boolean', true],
  ])('refuses a non-string approved-file entry (%s)', (_label, value) => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push(value); });
    const r = fx.load();
    expect(r.ok).toBe(false);
    expect(hasCode(r, 'schema_invalid', 'approved-files.json')).toBe(true);
  });

  it('rejects an exact duplicate approved file (schema uniqueItems)', () => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push('mock-api.js'); });
    const r = fx.load();
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.file === 'approved-files.json' && e.keyword === 'uniqueItems')).toBe(true);
  });

  it.each([['Mock-API.js'], ['MOCK-API.JS'], ['PUBLIC/button.js']])(
    'rejects a case-insensitive duplicate (%s) on every platform',
    (variant) => {
      // The duplicate decision is made on the lower-cased path before any file system access,
      // so it does not depend on whether the file system is case-sensitive.
      const fx = makeFixture();
      fx.edit('approved-files.json', (d) => { d.files.push(variant); });
      expect(hasCode(fx.load(), 'duplicate', 'approved-files.json')).toBe(true);
    }
  );



  it('rejects a directory', () => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push('public'); });
    expect(hasCode(fx.load(), 'unsafe_path', 'approved-files.json')).toBe(true);
  });

  it.skipIf(!CAN_JUNCTION)('rejects a directory junction or symlink that escapes the testapp directory', () => {
    const fx = makeFixture();
    const outside = path.join(fx.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.js'), 'x');
    fs.symlinkSync(outside, path.join(fx.testappDir, 'link'), 'junction');
    const r = resolveApprovedFile(fx.testappDir, 'link/secret.js');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('outside_root');
    fx.edit('approved-files.json', (d) => { d.files.push('link/secret.js'); });
    expect(hasCode(fx.load(), 'unsafe_path', 'approved-files.json')).toBe(true);
  });

  it.skipIf(!CAN_FILE_SYMLINK)('rejects a file symlink', () => {
    const fx = makeFixture();
    const target = path.join(fx.root, 'outside.js');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(fx.testappDir, 'linked.js'), 'file');
    const r = resolveApprovedFile(fx.testappDir, 'linked.js');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('symlink');
    fx.edit('approved-files.json', (d) => { d.files.push('linked.js'); });
    expect(hasCode(fx.load(), 'unsafe_path', 'approved-files.json')).toBe(true);
  });

  it.skipIf(!CAN_JUNCTION)('rejects a symlinked intermediate directory even when it stays inside the root', () => {
    const fx = makeFixture();
    fs.symlinkSync(path.join(fx.testappDir, 'public'), path.join(fx.testappDir, 'alias'), 'junction');
    const r = resolveApprovedFile(fx.testappDir, 'alias/button.js');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('symlink');
    fx.edit('approved-files.json', (d) => { d.files.push('alias/button.js'); });
    expect(hasCode(fx.load(), 'unsafe_path', 'approved-files.json')).toBe(true);
  });

  it('reports a missing testapp root with the distinct root_missing reason', () => {
    const fx = makeFixture();
    const r = loadConfig({ configDir: fx.configDir, testappDir: path.join(fx.root, 'nope') });
    expect(r.ok).toBe(false);
    const rootErrors = r.errors.filter((e) => e.file === 'approved-files.json');
    expect(rootErrors.length).toBeGreaterThan(0);
    for (const e of rootErrors) expect(e).toMatchObject({ code: 'file_not_found', reason: 'root_missing' });
    expect(resolveApprovedFile(path.join(fx.root, 'nope'), 'mock-api.js').code).toBe('root_missing');
  });
});

describe('sensitive file rejection', () => {
  const sensitive = [
    '.env', '.env.local', 'public/.ENV.production', 'package.json', 'PACKAGE.JSON', 'public/package.json',
    'package-lock.json', 'npm-shrinkwrap.json', 'node_modules/x/index.js', 'public/Node_Modules/a.js',
    'vitest.config.js', 'playwright.config.mjs', 'x.config.cjs', 'public/data.json', 'settings.yml', 'a.yaml',
    'pyproject.toml', 'setup.ini', '.npmrc', 'tsconfig.json', 'public/a.test.js', 'public/a.SPEC.js',
    'tests/a.js', 'public/__tests__/a.js', 'e2e/a.js', 'frontend/a.js', 'backend/a.js', '.kiro/a.js', '.git/a.js',
    'Frontend/App.js', 'public/.hidden.js',
    'health.js', 'HEALTH.JS', 'server.js', 'public/server.js', 'lib/Health.js',
  ];

  it.each(sensitive.map((p) => [p]))('checkSensitiveFile rejects %s', (p) => {
    const r = checkSensitiveFile(p);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('sensitive_file');
  });

  it.each(sensitive.map((p) => [p]))('loader refuses %s with sensitive_file', (p) => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push(p); });
    expect(hasCode(fx.load(), 'sensitive_file', 'approved-files.json')).toBe(true);
  });

  it('names verification-critical files in the message', () => {
    expect(checkSensitiveFile('public/server.js').message).toMatch(/verification-critical/);
  });

  it('refuses health.js and server.js even though both really exist in testapp/', () => {
    expect(fs.existsSync(path.join(DEFAULT_TESTAPP_DIR, 'health.js'))).toBe(true);
    expect(fs.existsSync(path.join(DEFAULT_TESTAPP_DIR, 'server.js'))).toBe(true);
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push('health.js', 'server.js'); });
    const r = fx.load();
    expect(r.ok).toBe(false);
    expect(r.errors.filter((e) => e.code === 'sensitive_file' && e.file === 'approved-files.json')).toHaveLength(2);
    expect(hasCode(r, 'file_not_found')).toBe(false);
  });

  it('accepts the shipped approved files', () => {
    const { config } = loadConfig();
    expect(config.approvedFiles).toHaveLength(8);
    for (const f of config.approvedFiles) expect(checkSensitiveFile(f), f).toEqual({ ok: true });
  });
});

describe('action type and file extension compatibility', () => {
  it.each([
    ['replace_text', 'public/button.js', true],
    ['replace_text', 'public/button.css', false],
    ['replace_style_rule', 'public/button.css', true],
    ['replace_style_rule', 'public/button.js', false],
    ['replace_style_rule', 'mock-api.js', false],
    ['replace_mock_api_handler', 'mock-api.js', true],
    ['replace_mock_api_handler', 'public/button.js', false],
    ['replace_mock_api_handler', 'public/mock-api.js', false],
    ['replace_mock_api_handler', 'Mock-API.js', false],
    ['run_shell', 'public/button.js', false],
  ])('%s on %s is compatible: %s', (action, file, expected) => {
    expect(actionFileCompatible(action, file)).toBe(expected);
  });

  it.each([
    [0, 'public/button.css'],
    [1, 'public/button.js'],
    [2, 'public/button.js'],
  ])('allowlist entry #%i refuses mismatched allowed file %s', (index, file) => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[index].allowedFiles.push(file); });
    expect(hasCode(fx.load(), 'unsafe_action_file', 'action-allowlist.json')).toBe(true);
  });

  it('refuses a scenario expectedRepairAction whose action does not suit the file', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].expectedRepairAction.actionType = 'replace_mock_api_handler'; });
    expect(hasCode(fx.load(), 'unsafe_action_file', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses a fallback plan whose action does not suit the file', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[1].planTemplate.actionType = 'replace_text'; });
    expect(hasCode(fx.load(), 'unsafe_action_file', 'fallback-mapping.json')).toBe(true);
  });
});

describe('action allowlist safety', () => {
  it('refuses an allowed file that is not approved', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[0].allowedFiles.push('server.js'); });
    expect(hasCode(fx.load(), 'not_approved', 'action-allowlist.json')).toBe(true);
  });

  it('refuses maxChangedLines above 50', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[0].maxChangedLines = 51; });
    expect(hasCode(fx.load(), 'unsafe_limit', 'action-allowlist.json')).toBe(true);
  });

  it('refuses an unknown action type and a missing required type', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[2].actionType = 'run_shell'; });
    const r = fx.load();
    expect(hasCode(r, 'unknown_action_type', 'action-allowlist.json')).toBe(true);
    expect(hasCode(r, 'missing_action_type', 'action-allowlist.json')).toBe(true);
  });
});

describe('scenario catalog safety', () => {
  it('refuses five scenarios', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios.pop(); });
    const r = fx.load();
    expect(r.errors.some((e) => e.file === 'scenario-catalog.json' && e.code === 'schema_invalid' && e.keyword === 'minItems')).toBe(true);
  });

  it('refuses seven scenarios', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios.push({ ...d.scenarios[0], scenarioId: 'extra-failure' }); });
    const r = fx.load();
    expect(r.errors.some((e) => e.file === 'scenario-catalog.json' && e.code === 'schema_invalid' && e.keyword === 'maxItems')).toBe(true);
  });

  it('refuses an unknown scenario ID and reports the missing approved one', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[5].scenarioId = 'extra-failure'; });
    const r = fx.load();
    expect(hasCode(r, 'unknown_scenario', 'scenario-catalog.json')).toBe(true);
    expect(hasCode(r, 'missing_scenario', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses duplicate scenario IDs', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[1].scenarioId = d.scenarios[0].scenarioId; });
    expect(hasCode(fx.load(), 'duplicate', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses a target file outside the approved files', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].targetFiles = ['server.js']; });
    expect(hasCode(fx.load(), 'not_approved', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses an unknown target component', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].targetComponent = 'database'; });
    expect(hasCode(fx.load(), 'schema_invalid', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses an expected repair action whose change exceeds maxChangedLines', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[0].maxChangedLines = 1; });
    fx.edit('scenario-catalog.json', (d) => {
      d.scenarios[0].expectedRepairAction.change.replace = 'a\nb\nc';
    });
    expect(hasCode(fx.load(), 'unsafe_limit', 'scenario-catalog.json')).toBe(true);
  });

  it('counts changed lines as the larger side of find and replace', () => {
    expect(changedLines({ find: 'a', replace: 'b' })).toBe(1);
    expect(changedLines({ find: 'a\nb\nc', replace: 'x' })).toBe(3);
    expect(changedLines({ find: 'a', replace: 'x\ny' })).toBe(2);
    expect(changedLines({ find: 'a', replace: '' })).toBe(1);
  });

  it('refuses an injection whose find text is not in the testapp file', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].injection.steps[0].find = 'this text is not there'; });
    expect(hasCode(fx.load(), 'transform_mismatch', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses an injection whose find text is ambiguous', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => {
      d.scenarios[0].injection.steps[0] = { file: 'public/button.js', find: 'count', replace: 'cnt' };
    });
    expect(hasCode(fx.load(), 'transform_mismatch', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses a reversal that does not restore the baseline', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].reversal.steps[0].replace = 'count = 0;'; });
    expect(hasCode(fx.load(), 'transform_mismatch', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses a transform that touches a file outside targetFiles', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].injection.steps[0].file = 'public/card.js'; });
    expect(hasCode(fx.load(), 'not_approved', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses when the testapp file no longer matches the baseline text', () => {
    const fx = makeFixture();
    const f = path.join(fx.testappDir, 'public', 'button.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('count = nextCount(count);', 'count = count;'));
    expect(hasCode(fx.load(), 'transform_mismatch', 'scenario-catalog.json')).toBe(true);
  });

  it('refuses an expected repair action outside the allowlist', () => {
    const fx = makeFixture();
    fx.edit('scenario-catalog.json', (d) => { d.scenarios[0].expectedRepairAction.actionType = 'replace_style_rule'; });
    expect(hasCode(fx.load(), 'not_allowlisted', 'scenario-catalog.json')).toBe(true);
  });
});

describe('command template restrictions', () => {
  it('refuses an arbitrary executable', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[1].executable = 'powershell'; });
    expect(hasCode(fx.load(), 'unsafe_command', 'command-templates.json')).toBe(true);
  });

  it('refuses allowedParams that are not exactly the component enum', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[1].allowedParams.push('rm -rf /'); });
    expect(hasCode(fx.load(), 'unsafe_params', 'command-templates.json')).toBe(true);
    const fx2 = makeFixture();
    fx2.edit('command-templates.json', (d) => { d.templates[1].allowedParams = ['button']; });
    expect(hasCode(fx2.load(), 'unsafe_params', 'command-templates.json')).toBe(true);
  });

  const unsafeCommand = (fx) => hasCode(fx.load(), 'unsafe_command', 'command-templates.json');
  const TEMPLATE_INDEX = { Health_Check: 0, Vitest: 1, Playwright: 2 };

  it('the shipped templates equal the pinned constants exactly', () => {
    const fx = makeFixture();
    const doc = fx.readJson('command-templates.json');
    expect(doc.templates.map((t) => t.templateId)).toEqual(['Health_Check', 'Vitest', 'Playwright']);
    for (const t of doc.templates) {
      const pin = PINNED_COMMAND_TEMPLATES[t.templateId];
      expect(t.executable).toBe(pin.executable);
      expect(t.args).toEqual([...pin.args]);
      expect(t.allowedParams).toEqual([...pin.allowedParams]);
      expect(t.timeoutMs).toBeLessThanOrEqual(pin.maxTimeoutMs);
    }
    expect(doc.templates[0].args[1]).toBe(HEALTH_CHECK_SCRIPT);
    expect(HEALTH_CHECK_SCRIPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a tampered Health_Check script (appended, prepended, or different URL)', () => {
    for (const tamper of [
      (s) => `${s};process.exit(0)`,
      (s) => `process.exit(0);${s}`,
      (s) => s.replace('127.0.0.1:4100', '127.0.0.1:9999'),
      (s) => s.replace("m[k].status!=='ok'", "m[k].status===undefined"),
      (s) => s.replace('r.status!==200||', ''),
    ]) {
      const fx = makeFixture();
      fx.edit('command-templates.json', (d) => { d.templates[0].args[1] = tamper(d.templates[0].args[1]); });
      expect(unsafeCommand(fx)).toBe(true);
    }
  });

  it.each(['Vitest', 'Playwright'])('refuses an arbitrary script path for %s', (id) => {
    for (const evil of ['../../evil.js', '/tmp/evil.js', 'testapp/evil.js', 'backend/node_modules/vitest/../../evil.js']) {
      const fx = makeFixture();
      fx.edit('command-templates.json', (d) => { d.templates[TEMPLATE_INDEX[id]].args[0] = evil; });
      expect(unsafeCommand(fx), evil).toBe(true);
    }
  });

  it.each(['Health_Check', 'Vitest', 'Playwright'])('refuses extra, removed and reordered arguments for %s', (id) => {
    const i = TEMPLATE_INDEX[id];
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[i].args.push('extra'); });
    expect(unsafeCommand(fx)).toBe(true);
    const fx2 = makeFixture();
    fx2.edit('command-templates.json', (d) => { d.templates[i].args.pop(); });
    expect(unsafeCommand(fx2)).toBe(true);
    const fx3 = makeFixture();
    fx3.edit('command-templates.json', (d) => { d.templates[i].args.reverse(); });
    expect(unsafeCommand(fx3)).toBe(true);
    const fx4 = makeFixture();
    fx4.edit('command-templates.json', (d) => { d.templates[i].args = []; });
    expect(unsafeCommand(fx4)).toBe(true);
  });

  it.each(['--input-type=module', '--input-type', '--env-file=.env', '--test', '-e', '--eval=process.exit()', '-r', '--require=./x.js', '--import=./x.mjs', '-p'])(
    'refuses the Node option %s added to any template',
    (option) => {
      for (const id of Object.keys(TEMPLATE_INDEX)) {
        const first = makeFixture();
        first.edit('command-templates.json', (d) => { d.templates[TEMPLATE_INDEX[id]].args.unshift(option); });
        expect(unsafeCommand(first), `${id} unshift`).toBe(true);
        const last = makeFixture();
        last.edit('command-templates.json', (d) => { d.templates[TEMPLATE_INDEX[id]].args.push(option); });
        expect(unsafeCommand(last), `${id} push`).toBe(true);
      }
    }
  );

  it.each(['Health_Check', 'Vitest', 'Playwright'])('refuses a different executable for %s', (id) => {
    for (const exe of ['npx', 'node.exe', '/usr/bin/node', 'NODE', 'sh']) {
      const fx = makeFixture();
      fx.edit('command-templates.json', (d) => { d.templates[TEMPLATE_INDEX[id]].executable = exe; });
      expect(unsafeCommand(fx), exe).toBe(true);
    }
  });

  it('refuses changed allowedParams (extra, reordered, renamed, empty)', () => {
    for (const change of [
      (p) => p.push('database'),
      (p) => p.reverse(),
      (p) => { p[0] = 'Button'; },
      (p) => p.splice(0, p.length),
    ]) {
      const fx = makeFixture();
      fx.edit('command-templates.json', (d) => { change(d.templates[0].allowedParams); });
      expect(hasCode(fx.load(), 'unsafe_params', 'command-templates.json')).toBe(true);
    }
  });

  it('refuses an extra unknown template and a duplicated template', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates.push({ ...structuredClone(d.templates[1]), templateId: 'Shell' }); });
    expect(hasCode(fx.load(), 'unknown_template', 'command-templates.json')).toBe(true);
    const fx2 = makeFixture();
    fx2.edit('command-templates.json', (d) => { d.templates.push(structuredClone(d.templates[1])); });
    expect(hasCode(fx2.load(), 'duplicate', 'command-templates.json')).toBe(true);
  });

  it('refuses a missing required template and prototype-named template IDs', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates.pop(); });
    expect(hasCode(fx.load(), 'missing_template', 'command-templates.json')).toBe(true);
    const fx2 = makeFixture();
    fx2.edit('command-templates.json', (d) => { d.templates[0].templateId = 'toString'; });
    expect(hasCode(fx2.load(), 'unknown_template', 'command-templates.json')).toBe(true);
  });

  it.each([['Health_Check', 10000], ['Vitest', 60000], ['Playwright', 90000]])('caps the %s timeout at %i ms', (id, cap) => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[TEMPLATE_INDEX[id]].timeoutMs = cap + 1; });
    expect(hasCode(fx.load(), 'unsafe_limit', 'command-templates.json')).toBe(true);
    const ok = makeFixture();
    ok.edit('command-templates.json', (d) => { d.templates[TEMPLATE_INDEX[id]].timeoutMs = cap; });
    expect(ok.load().ok).toBe(true);
  });

  it('refuses a missing or unknown template', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[2].templateId = 'Shell'; });
    const r = fx.load();
    expect(hasCode(r, 'unknown_template', 'command-templates.json')).toBe(true);
    expect(hasCode(r, 'missing_template', 'command-templates.json')).toBe(true);
  });

  it('refuses an excessive timeout', () => {
    const fx = makeFixture();
    fx.edit('command-templates.json', (d) => { d.templates[1].timeoutMs = 99999999; });
    expect(hasCode(fx.load(), 'unsafe_limit', 'command-templates.json')).toBe(true);
  });
});

describe('fallback mapping safety', () => {
  it('refuses a scenario ID in any value', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].planTemplate.rationale = 'Fix for button-failure'; });
    expect(hasCode(fx.load(), 'scenario_id_leak', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses a scenario ID in an entry ID or a scenarioId key', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[1].entryId = 'fm-Layout-Corruption'; });
    expect(hasCode(fx.load(), 'scenario_id_leak', 'fallback-mapping.json')).toBe(true);
    const fx2 = makeFixture();
    fx2.edit('fallback-mapping.json', (d) => { d.entries[1].evidencePattern.scenarioId = 'x'; });
    expect(hasCode(fx2.load(), 'scenario_id_leak', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses when a scenario has no covering entry', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries.splice(3, 1); });
    const r = fx.load();
    expect(hasCode(r, 'coverage_gap', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses a plan whose target is not allowlisted for its action', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].planTemplate.actionType = 'replace_mock_api_handler'; });
    expect(hasCode(fx.load(), 'not_allowlisted', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses an invalid evidence regular expression', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].evidencePattern.errorPattern = '(unclosed'; });
    expect(hasCode(fx.load(), 'invalid_evidence_pattern', 'fallback-mapping.json')).toBe(true);
  });

  it.each(['command', 'shell', 'script'])('refuses a plan that carries a %s field', (key) => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].planTemplate[key] = 'rm -rf /'; });
    const r = fx.load();
    expect(hasCode(r, 'schema_invalid', 'fallback-mapping.json')).toBe(true);
    if (key !== 'script') expect(hasCode(r, 'unsafe_command', 'fallback-mapping.json')).toBe(true);
  });

  it.each([
    ['entry', (e) => { e.extra = 1; }],
    ['evidencePattern', (e) => { e.evidencePattern.extra = 1; }],
    ['sourceCheck', (e) => { e.sourceCheck.extra = 1; }],
    ['diagnosisTemplate', (e) => { e.diagnosisTemplate.extra = 1; }],
    ['planTemplate', (e) => { e.planTemplate.extra = 1; }],
    ['planTemplate.change', (e) => { e.planTemplate.change.extra = 1; }],
  ])('refuses an unknown key in %s', (_where, mutate) => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => mutate(d.entries[0]));
    const r = fx.load();
    expect(r.errors.some((e) => e.file === 'fallback-mapping.json' && e.code === 'schema_invalid' && e.keyword === 'additionalProperties')).toBe(true);
  });

  it.each([
    ['unknown healthCheckId', (e) => { e.evidencePattern.healthCheckId = 'database'; }],
    ['status other than fail', (e) => { e.evidencePattern.status = 'ok'; }],
    ['empty errorPattern', (e) => { e.evidencePattern.errorPattern = ''; }],
    ['errorPattern over 200 chars', (e) => { e.evidencePattern.errorPattern = 'a'.repeat(201); }],
    ['confidence above 1', (e) => { e.diagnosisTemplate.confidence = 1.5; }],
    ['confidence below 0', (e) => { e.diagnosisTemplate.confidence = -0.1; }],
    ['empty find', (e) => { e.planTemplate.change.find = ''; }],
  ])('refuses %s', (_name, mutate) => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => mutate(d.entries[0]));
    expect(hasCode(fx.load(), 'schema_invalid', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses a diagnosis component that differs from the evidence healthCheckId', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].diagnosisTemplate.component = 'card'; });
    expect(hasCode(fx.load(), 'invalid_template', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses an ambiguous mapping when a duplicate entry matches the same scenario', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries.push({ ...structuredClone(d.entries[0]), entryId: 'fm-duplicate-of-first' }); });
    const r = fx.load();
    expect(hasCode(r, 'ambiguous_mapping', 'fallback-mapping.json')).toBe(true);
    expect(hasCode(r, 'coverage_gap')).toBe(false);
    expect(hasCode(r, 'orphan_entry')).toBe(false);
  });

  it('refuses an orphan entry that matches no approved demo scenario', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => {
      const orphan = structuredClone(d.entries[0]);
      orphan.entryId = 'fm-orphan';
      orphan.sourceCheck.contains = 'nextCount(count)'; // present in the baseline, so never a failure symptom
      d.entries.push(orphan);
    });
    const r = fx.load();
    expect(hasCode(r, 'orphan_entry', 'fallback-mapping.json')).toBe(true);
    expect(r.errors.find((e) => e.code === 'orphan_entry').message).toContain('fm-orphan');
  });

  it('refuses an entry whose component differs from the scenario it would repair', () => {
    const fx = makeFixture();
    // Component changed consistently in evidence and diagnosis, so only the scenario match fails.
    fx.edit('fallback-mapping.json', (d) => {
      d.entries[0].evidencePattern.healthCheckId = 'card';
      d.entries[0].diagnosisTemplate.component = 'card';
    });
    const r = fx.load();
    expect(hasCode(r, 'invalid_template')).toBe(false);
    expect(hasCode(r, 'coverage_gap', 'fallback-mapping.json')).toBe(true);
    expect(hasCode(r, 'orphan_entry', 'fallback-mapping.json')).toBe(true);
  });

  it('refuses a plan change larger than the allowlisted maxChangedLines', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[0].maxChangedLines = 2; });
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].planTemplate.change.replace = ['a', 'b', 'c'].join('\n'); });
    expect(hasCode(fx.load(), 'unsafe_limit', 'fallback-mapping.json')).toBe(true);
  });

  it('accepts a plan change exactly at the limit', () => {
    const fx = makeFixture();
    fx.edit('action-allowlist.json', (d) => { d[0].maxChangedLines = 1; });
    expect(fx.load().ok).toBe(true);
  });

  it('refuses a sourceCheck file that is not approved', () => {
    const fx = makeFixture();
    fx.edit('fallback-mapping.json', (d) => { d.entries[0].sourceCheck.file = 'server.js'; });
    expect(hasCode(fx.load(), 'invalid_source_check', 'fallback-mapping.json')).toBe(true);
  });
});

describe('fallbackEntryMatchesEvidence (shared runtime matcher)', () => {
  const entry = {
    entryId: 'fm-x',
    evidencePattern: { healthCheckId: 'button', status: 'fail', errorPattern: '^click handler produced' },
    sourceCheck: { file: 'public/button.js', contains: 'count = count;' },
  };
  const good = [{ healthCheckId: 'button', status: 'fail', error: 'click handler produced "Clicked 0 times"' }];
  const read = () => 'x count = count; y';

  it('matches when check id, failing status, error pattern and source text all agree', () => {
    expect(fallbackEntryMatchesEvidence(entry, good, read)).toBe(true);
  });

  it.each([
    ['wrong healthCheckId', [{ ...good[0], healthCheckId: 'card' }], read],
    ['status ok', [{ ...good[0], status: 'ok' }], read],
    ['error not matching the pattern', [{ ...good[0], error: 'something else' }], read],
    ['missing error text', [{ healthCheckId: 'button', status: 'fail' }], read],
    ['sourceCheck text absent', good, () => 'nothing here'],
    ['file unreadable', good, () => undefined],
    ['no evidence', [], read],
  ])('does not match: %s', (_name, evidence, readFile) => {
    expect(fallbackEntryMatchesEvidence(entry, evidence, readFile)).toBe(false);
  });

  it('only reads the sourceCheck file and takes no scenario input', () => {
    const asked = [];
    fallbackEntryMatchesEvidence(entry, good, (p) => { asked.push(p); return read(); });
    expect(asked).toEqual(['public/button.js']);
    expect(fallbackEntryMatchesEvidence.length).toBe(3);
  });
});

describe('startup refusal', () => {
  it('initializeConfig returns the config when everything is valid', () => {
    const config = initializeConfig();
    expect(config.scenarioCatalog).toHaveLength(6);
  });

  it('initializeConfig throws a structured ConfigError when a file is missing', () => {
    const fx = makeFixture();
    fs.rmSync(path.join(fx.configDir, 'scenario-catalog.json'));
    let thrown;
    try { initializeConfig({ configDir: fx.configDir, testappDir: fx.testappDir }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown.errors[0]).toMatchObject({ file: 'scenario-catalog.json', code: 'missing_file' });
  });

  it('initializeConfig throws on an invalid file and reports every problem', () => {
    const fx = makeFixture();
    fx.edit('approved-files.json', (d) => { d.files.push('../escape.js'); });
    fx.edit('command-templates.json', (d) => { d.templates[1].executable = 'cmd'; });
    let thrown;
    try { initializeConfig({ configDir: fx.configDir, testappDir: fx.testappDir }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(codes({ ok: false, errors: thrown.errors })).toEqual(expect.arrayContaining(['unsafe_path', 'unsafe_command']));
  });

  it('does not fall back to defaults when a config directory is empty', () => {
    const fx = makeFixture();
    for (const name of Object.values(CONFIG_FILES)) fs.rmSync(path.join(fx.configDir, name));
    const r = fx.load();
    expect(r.ok).toBe(false);
    expect(r.errors.filter((e) => e.code === 'missing_file')).toHaveLength(5);
  });
});

describe('scenarios against the real Test_App health checks (temporary copy)', () => {
  const apply = (dir, steps) => {
    for (const s of steps) {
      const f = path.join(dir, ...s.file.split('/'));
      const text = fs.readFileSync(f, 'utf8');
      expect(text.split(s.find).length - 1).toBe(1);
      fs.writeFileSync(f, text.replace(s.find, () => s.replace));
    }
  };

  async function healthOf(testappDir) {
    const req = createRequire(path.join(testappDir, 'server.js'));
    // Node caches required modules; drop this copy's entries so edited files are re-read
    // (a live Test_App would need a restart for mock-api.js changes to take effect).
    for (const key of Object.keys(req.cache)) if (key.startsWith(testappDir)) delete req.cache[key];
    const { createServer } = req('./server.js');
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      return await res.json();
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const evidenceOf = (health) =>
    Object.entries(health.components).map(([healthCheckId, v]) => ({ healthCheckId, status: v.status, error: v.error }));

  it('baseline is healthy', async () => {
    const fx = makeFixture();
    const health = await healthOf(fx.testappDir);
    expect(health.status).toBe('ok');
  });

  it.each(REQUIRED_SCENARIO_IDS)('%s: injection fails a health check, a mapping entry matches it, and its plan restores health', async (id) => {
    const fx = makeFixture();
    const { config } = loadConfig({ configDir: fx.configDir, testappDir: fx.testappDir });
    const scenario = config.scenarioCatalog.find((s) => s.scenarioId === id);

    apply(fx.testappDir, scenario.injection.steps);
    const broken = await healthOf(fx.testappDir);
    expect(broken.status).toBe('degraded');
    const failing = Object.entries(broken.components).filter(([, v]) => v.status === 'fail');
    expect(failing.length).toBeGreaterThan(0);

    // Evidence-only matching: health check name + error text, then the source check.
    const evidence = evidenceOf(broken);
    const readFile = (rel) => fs.readFileSync(path.join(fx.testappDir, ...rel.split('/')), 'utf8');
    const matches = config.fallbackMapping.filter((e) => fallbackEntryMatchesEvidence(e, evidence, readFile));
    expect(matches).toHaveLength(1);

    // A wrong errorPattern must stop the shared matcher from matching the real health output.
    const wrong = { ...matches[0], evidencePattern: { ...matches[0].evidencePattern, errorPattern: '^this text never appears' } };
    expect(fallbackEntryMatchesEvidence(wrong, evidence, readFile)).toBe(false);

    apply(fx.testappDir, [{ file: matches[0].planTemplate.targetFile, ...matches[0].planTemplate.change }]);
    const repaired = await healthOf(fx.testappDir);
    expect(repaired.status).toBe('ok');

    // Reversal alone also restores baseline content.
    const fx2 = makeFixture();
    apply(fx2.testappDir, scenario.injection.steps);
    apply(fx2.testappDir, scenario.reversal.steps);
    for (const rel of config.approvedFiles) {
      const p = ['testapp'].concat(rel.split('/'));
      expect(fs.readFileSync(path.join(fx2.root, ...p), 'utf8')).toBe(
        fs.readFileSync(path.join(DEFAULT_TESTAPP_DIR, ...rel.split('/')), 'utf8')
      );
    }
  });
});
