import { loadSource, readPublic, cssRule, fakeDocument } from './helpers.js';

describe('button component', () => {
  const button = loadSource('public/button.js');

  it('increments the count and labels it', () => {
    expect(button.nextCount(0)).toBe(1);
    expect(button.nextCount(41)).toBe(42);
    expect(button.label(2)).toBe('Clicked 2 times');
  });

  it('click handler updates the output on every click', () => {
    const doc = fakeDocument(['test-button', 'button-output']);
    button.mount(doc);
    doc.els['test-button'].click();
    expect(doc.els['button-output'].textContent).toBe('Clicked 1 times');
    doc.els['test-button'].click();
    doc.els['test-button'].click();
    expect(doc.els['button-output'].textContent).toBe('Clicked 3 times');
  });

  it('is present in index.html and styled by a #test-button rule that keeps it visible', () => {
    const html = readPublic('index.html');
    expect(html).toContain('id="test-button"');
    expect(html).toContain('/button.js');
    expect(html).toContain('/button.css');
    const rule = cssRule(readPublic('button.css'), '#test-button');
    expect(rule).not.toBeNull();
    expect(rule.padding).toBeTruthy();
    expect(rule.background).toBeTruthy();
    expect(rule.display).not.toBe('none');
  });
});
