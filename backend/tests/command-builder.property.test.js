import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandBuilder, CommandBuildError } from '../src/verification/command-builder.js';

// Feature: poltergeist-exorcist-healing-system, Property 33: Fixed command templates
// **Validates: Requirements 17.6**

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(fs.readFileSync(path.join(here, '../config/command-templates.json'), 'utf8'));
const templates = doc.templates;
const builder = createCommandBuilder(templates);
const byId = new Map(templates.map((t) => [t.templateId, t]));

const METACHARS = ['; rm -rf /', '&& calc', '| cat', '$(whoami)', '`id`', '> out.txt', '\n', '"', "'", '..\\..', '--eval'];
const arbText = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(...METACHARS),
  fc.tuple(fc.constantFrom(...METACHARS), fc.string()).map(([a, b]) => a + b),
);
const arbTemplateId = fc.oneof(fc.constantFrom(...byId.keys()), arbText);
const arbEnum = fc.constantFrom(...templates[0].allowedParams);
const arbParam = fc.oneof(
  fc.constant(undefined),
  arbEnum,
  arbText,
  fc.constantFrom(null, 0, 1, true, {}, [], ['button']),
  fc.constantFrom('Button', ' button', 'button ', 'button\n', 'BUTTON', '__proto__', 'toString'),
);

describe('Property 33: Fixed command templates', () => {
  it('returns only template-derived invocations (no shell) or rejects', () => {
    fc.assert(
      fc.property(arbTemplateId, arbParam, (templateId, param) => {
        let result;
        try {
          result = builder.build(templateId, param);
        } catch (e) {
          expect(e).toBeInstanceOf(CommandBuildError);
          expect(['unknown_template', 'invalid_param']).toContain(e.code);
          return;
        }
        const t = byId.get(templateId);
        expect(t).toBeDefined();
        expect(result.executable).toBe(t.executable);
        expect(result.timeoutMs).toBe(t.timeoutMs);
        expect(Object.keys(result).sort()).toEqual(['args', 'executable', 'timeoutMs']);
        expect(result.shell).toBeUndefined();
        expect(Array.isArray(result.args)).toBe(true);
        if (param === undefined) {
          expect(result.args).toEqual(t.args);
        } else {
          expect(t.allowedParams).toContain(param);
          expect(result.args).toEqual([...t.args, param]);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('rejects any non-enum parameter and never echoes agent text', () => {
    fc.assert(
      fc.property(fc.constantFrom(...byId.keys()), arbText, (templateId, text) => {
        const t = byId.get(templateId);
        if (t.allowedParams.includes(text)) return;
        expect(() => builder.build(templateId, text)).toThrow(CommandBuildError);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects unknown template IDs', () => {
    fc.assert(
      fc.property(arbText, (id) => {
        fc.pre(!byId.has(id));
        expect(() => builder.build(id)).toThrow(CommandBuildError);
      }),
      { numRuns: 300 },
    );
  });

  it('is not affected by later mutation of the source templates', () => {
    const copy = JSON.parse(JSON.stringify(templates));
    const b = createCommandBuilder(copy);
    const before = b.build('Vitest', 'card');
    copy[1].args.push('--evil');
    copy[1].executable = 'sh';
    expect(b.build('Vitest', 'card')).toEqual(before);
  });
});
