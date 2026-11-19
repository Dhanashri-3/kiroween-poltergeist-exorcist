import { loadSource, readPublic, cssRule, fakeDocument } from './helpers.js';

describe('card component', () => {
  const card = loadSource('public/card.js');

  it('renders title and body and escapes markup', () => {
    const html = card.render('Title', '<b>x</b>');
    expect(html).toContain('<h2 class="card-title">Title</h2>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('mounts into #test-card', () => {
    const doc = fakeDocument(['test-card']);
    card.mount(doc);
    expect(doc.els['test-card'].innerHTML).toContain('card-title');
  });

  it('is present in index.html and styled with a visible .card rule', () => {
    const html = readPublic('index.html');
    expect(html).toContain('id="test-card"');
    expect(html).toContain('/card.css');
    const rule = cssRule(readPublic('card.css'), '.card');
    expect(rule).not.toBeNull();
    expect(rule.background).toBe('#ffffff');
    expect(rule.border).toBeTruthy();
    expect(rule.padding).toBeTruthy();
    expect(rule.display).not.toBe('none');
    expect(rule.visibility).not.toBe('hidden');
  });
});
