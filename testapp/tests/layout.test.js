import { readPublic, cssRule } from './helpers.js';

describe('layout section', () => {
  it('is present in index.html and loads layout.css', () => {
    const html = readPublic('index.html');
    expect(html).toContain('class="layout-section"');
    expect(html).toContain('/layout.css');
  });

  it('uses a grid with two columns, a gap and numeric padding', () => {
    const rule = cssRule(readPublic('layout.css'), '.layout-section');
    expect(rule).not.toBeNull();
    expect(rule.display).toBe('grid');
    expect(rule['grid-template-columns']).toBe('1fr 1fr');
    expect(rule.gap).toMatch(/^\d+px$/);
    expect(rule.padding).toMatch(/^\d+(px|%|rem|em)?$/);
  });

  it('is not hidden', () => {
    const rule = cssRule(readPublic('layout.css'), '.layout-section');
    expect(rule.visibility).not.toBe('hidden');
    expect(rule.display).not.toBe('none');
  });
});
