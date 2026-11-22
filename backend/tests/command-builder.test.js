import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandBuilder, createCommandBuilderFromConfig, CommandBuildError } from '../src/verification/command-builder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'command-templates.json'), 'utf8'));
const builder = createCommandBuilder(doc.templates);

describe('command builder', () => {
  it('builds executable + args + timeout with no shell field', () => {
    const cmd = builder.build('Health_Check', 'button');
    const t = doc.templates.find((x) => x.templateId === 'Health_Check');
    expect(cmd).toEqual({ executable: 'node', args: [...t.args, 'button'], timeoutMs: 10000 });
    expect(cmd).not.toHaveProperty('shell');
  });

  it('builds without a param using only fixed args', () => {
    expect(builder.build('Vitest').args).toEqual(doc.templates[1].args);
  });

  it('rejects unknown templateId', () => {
    expect(() => builder.build('Rm')).toThrow(/Unknown command template/);
    expect(() => builder.build('constructor')).toThrow(/Unknown command template/);
  });

  it('rejects params outside the component enum', () => {
    for (const p of ['; rm -rf /', 'Button', '', 'button extra', 5, null]) {
      expect(() => builder.build('Health_Check', p)).toThrow(/not an allowed component/);
    }
  });

  it('is unaffected by mutation of returned args or of the source templates', () => {
    const local = JSON.parse(JSON.stringify(doc.templates));
    const b = createCommandBuilder(local);
    b.build('Vitest').args.push('--evil');
    local[1].args.push('--evil');
    local[1].allowedParams.push('--evil');
    expect(b.build('Vitest').args).toEqual(doc.templates[1].args);
    expect(() => b.build('Vitest', '--evil')).toThrow(CommandBuildError);
  });

  it('builds from the validated on-disk configuration', () => {
    const b = createCommandBuilderFromConfig();
    for (const t of doc.templates) {
      for (const c of t.allowedParams) {
        expect(b.build(t.templateId, c)).toEqual({ executable: t.executable, args: [...t.args, c], timeoutMs: t.timeoutMs });
      }
    }
  });
});
